#!/usr/bin/env bash
# Idempotent GitHub release asset upload. Source this file, then call
# upload_release_assets <tag> <file> [file...] (typically inside retry_command).
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

upload_release_assets() {
  local tag="$1"
  shift

  local repo="${GH_REPO:-${GITHUB_REPOSITORY:?GH_REPO or GITHUB_REPOSITORY must be set}}"

  # Captured into a variable rather than streamed via process substitution: a
  # `done < <(gh api ...)` failure is invisible to the loop, so a transient 5xx
  # on the listing would silently skip the delete pass and degrade this back to
  # the bare --clobber upload the helper exists to replace.
  local listing
  if ! listing="$(gh api "repos/${repo}/releases/tags/${tag}" \
    --jq '.assets[] | [(.id | tostring), .name] | @tsv')"; then
    echo "Failed to list existing assets for ${tag}" >&2
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
