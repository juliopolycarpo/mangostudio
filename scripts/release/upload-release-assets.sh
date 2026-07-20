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

upload_release_assets() {
  local tag="$1"
  shift

  local repo="${GH_REPO:-${GITHUB_REPOSITORY:?GH_REPO or GITHUB_REPOSITORY must be set}}"

  local asset_id asset_name file
  while IFS=$'\t' read -r asset_id asset_name; do
    [ -n "$asset_id" ] || continue
    for file in "$@"; do
      if [ "$(basename "$file")" = "$asset_name" ]; then
        echo "Deleting existing release asset ${asset_name} (id ${asset_id}) before upload"
        gh api --method DELETE "repos/${repo}/releases/assets/${asset_id}" >/dev/null
        break
      fi
    done
  done < <(
    gh api "repos/${repo}/releases/tags/${tag}" \
      --jq '.assets[] | [(.id | tostring), .name] | @tsv'
  )

  # --clobber stays as a last line of defense against assets created between
  # the listing above and this upload.
  gh release upload "$tag" "$@" --clobber
}
