#!/usr/bin/env bash
# Idempotent GitHub release asset upload. Source this file, then call
# upload_release_assets <tag> <file> [file...] (typically inside retry_command),
# or purge_stale_release_assets <tag> <file> [file...] to drop remote assets
# that no longer belong.
#
# `gh release upload --clobber` alone is not safe to retry: an upload that dies
# mid-flight (HTTP 5xx) can leave a same-name asset behind — including assets
# stuck in the un-finalized "starter" state that `--clobber` does not replace —
# and the next attempt then fails with HTTP 422 "ReleaseAsset.name already
# exists". Deleting every conflicting asset by id first gives each attempt a
# clean slate, so the outer retry loop converges instead of wedging.
#
# Every `gh` failure here is fatal to the call so the outer retry_command sees
# it: callers invoke this under `retry_command`, which runs it as the left
# operand of `&&` and therefore disables errexit for the whole function body.

# Lists a release's current assets as "id<TAB>name" lines.
#
# Captured into a variable rather than streamed via process substitution: a
# `done < <(gh api ...)` failure is invisible to the loop, so a transient 5xx
# on the listing would silently skip the caller's delete pass.
_list_release_assets() {
  local tag="$1"
  local repo="${GH_REPO:-${GITHUB_REPOSITORY:?GH_REPO or GITHUB_REPOSITORY must be set}}"
  if ! gh api "repos/${repo}/releases/tags/${tag}" \
    --jq '.assets[] | [(.id | tostring), .name] | @tsv'; then
    echo "Failed to list existing assets for ${tag}" >&2
    return 1
  fi
}

upload_release_assets() {
  local tag="$1"
  shift

  local repo="${GH_REPO:-${GITHUB_REPOSITORY:?GH_REPO or GITHUB_REPOSITORY must be set}}"

  local listing
  if ! listing="$(_list_release_assets "$tag")"; then
    return 1
  fi

  local name
  local -a upload_names=()
  for name in "$@"; do
    upload_names+=("$(basename "$name")")
  done

  local asset_id asset_name
  while IFS=$'\t' read -r asset_id asset_name; do
    [ -n "$asset_id" ] || continue
    for name in "${upload_names[@]}"; do
      if [ "$name" = "$asset_name" ]; then
        echo "Deleting existing release asset ${asset_name} (id ${asset_id}) before upload"
        # </dev/null keeps gh from consuming the loop's own stdin.
        if ! gh api --method DELETE "repos/${repo}/releases/assets/${asset_id}" \
          >/dev/null </dev/null; then
          echo "Failed to delete release asset ${asset_name} (id ${asset_id})" >&2
          return 1
        fi
        break
      fi
    done
  done <<<"$listing"

  # --clobber stays as a last line of defense against assets created between
  # the listing above and this upload.
  gh release upload "$tag" "$@" --clobber
}

# Deletes every asset on a release whose name is not in the given file list.
#
# For a rolling tag (canary), the set of asset names a run wants to publish can
# shrink between runs — a platform dropped from `CANARY_PAIR_PLATFORMS`, say.
# `upload_release_assets` only ever replaces conflicting names, so a name it no
# longer uploads is never revisited and stays attached to the release forever.
# Call this after publishing to bring the release's asset list back in sync
# with what this run actually intends to keep.
purge_stale_release_assets() {
  local tag="$1"
  shift

  local repo="${GH_REPO:-${GITHUB_REPOSITORY:?GH_REPO or GITHUB_REPOSITORY must be set}}"

  local listing
  if ! listing="$(_list_release_assets "$tag")"; then
    return 1
  fi

  local name
  local -a keep_names=()
  for name in "$@"; do
    keep_names+=("$(basename "$name")")
  done

  local asset_id asset_name found
  while IFS=$'\t' read -r asset_id asset_name; do
    [ -n "$asset_id" ] || continue
    found=0
    for name in "${keep_names[@]}"; do
      if [ "$name" = "$asset_name" ]; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      echo "Purging stale release asset ${asset_name} (id ${asset_id}); not part of the current asset set"
      # </dev/null keeps gh from consuming the loop's own stdin.
      if ! gh api --method DELETE "repos/${repo}/releases/assets/${asset_id}" \
        >/dev/null </dev/null; then
        echo "Failed to delete stale release asset ${asset_name} (id ${asset_id})" >&2
        return 1
      fi
    fi
  done <<<"$listing"
}
