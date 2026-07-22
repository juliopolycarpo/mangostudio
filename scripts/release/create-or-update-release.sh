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
# Every `gh` failure here is fatal to the call so the outer workflow step sees
# it. Failure propagation is explicit (`|| return`) rather than errexit-based:
# a caller that wraps this in `if`/`&&`/`||` disables errexit for the whole
# function body, and a swallowed edit failure would then upload assets onto a
# release whose title/notes never landed.

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

  local release_exists=0
  if gh release view "$tag" >/dev/null 2>&1; then
    release_exists=1
  fi

  # Stateful create loop: retry_command only repeats one command and cannot
  # re-probe between failures, so keep the view probe here. The probe runs
  # immediately after a failed create — before any backoff — so the wedge case
  # (release created server-side, CLI exited non-zero) falls straight through
  # to the edit + upload path below instead of sleeping first.
  local attempt=1
  local -r create_attempts=3
  while [ "$release_exists" -eq 0 ]; do
    if gh release create "$tag" "${assets[@]}" "${flags[@]}"; then
      return 0
    fi
    if gh release view "$tag" >/dev/null 2>&1; then
      release_exists=1
      break
    fi
    if [ "$attempt" -ge "$create_attempts" ]; then
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 30
  done

  retry_command 3 30 gh release edit "$tag" "${flags[@]}" || return
  retry_command 3 30 upload_release_assets "$tag" "${assets[@]}"
}
