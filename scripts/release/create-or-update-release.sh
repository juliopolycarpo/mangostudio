#!/usr/bin/env bash
# Idempotent GitHub release create-or-update. Source this file, then call
# create_or_update_release <tag> <asset> [asset...] -- <gh-release-flags...>
#
# Stateful retry: scripts/release/retry.sh cannot model the post-failure
# release lookup that recovers from a partially created tag (create succeeds
# server-side, then the CLI exits non-zero mid-asset-upload). A bare
# `retry_command … gh release create` then fails forever with
# `422 already_exists`. Re-probe `gh release view` between attempts and fall
# through to edit + upload_release_assets when the release appears.
#
# Every `gh` failure here is fatal to the call so the outer workflow step
# sees it: callers invoke this under bash -e, and edit/upload failures
# propagate through retry_command.

# shellcheck source=retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/retry.sh"
# shellcheck source=upload-release-assets.sh
source "$(dirname "${BASH_SOURCE[0]}")/upload-release-assets.sh"

create_or_update_release() {
  local tag="$1"
  shift

  local -a assets=()
  local -a flags=()
  local saw_separator=0
  local arg
  for arg in "$@"; do
    if [ "$saw_separator" -eq 0 ] && [ "$arg" = "--" ]; then
      saw_separator=1
      continue
    fi
    if [ "$saw_separator" -eq 0 ]; then
      assets+=("$arg")
    else
      flags+=("$arg")
    fi
  done

  if [ "${#assets[@]}" -eq 0 ]; then
    echo "create_or_update_release: at least one asset is required" >&2
    return 1
  fi
  if [ "$saw_separator" -eq 0 ]; then
    echo "create_or_update_release: missing -- separator before gh release flags" >&2
    return 1
  fi

  if gh release view "$tag" >/dev/null 2>&1; then
    retry_command 3 30 gh release edit "$tag" "${flags[@]}"
    retry_command 3 30 upload_release_assets "$tag" "${assets[@]}"
    return
  fi

  # Stateful create loop: retry_command only repeats one command and cannot
  # re-probe between failures, so keep the view probe here.
  local attempt
  for attempt in 1 2 3; do
    if gh release create "$tag" "${assets[@]}" "${flags[@]}"; then
      return 0
    fi
    if gh release view "$tag" >/dev/null 2>&1; then
      retry_command 3 30 gh release edit "$tag" "${flags[@]}"
      retry_command 3 30 upload_release_assets "$tag" "${assets[@]}"
      return
    fi
    if [ "$attempt" = "3" ]; then
      return 1
    fi
    sleep 30
  done
}
