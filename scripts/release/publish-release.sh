#!/usr/bin/env bash
# Publish a GitHub release whose assets are attached before it goes public.
# Source this file, then call
#   publish_release <tag> <asset> [asset...] -- <gh-release-flags...>
#
# Why one call and never an update: this repository has **immutable releases**
# enabled, so a published release's assets cannot be replaced or deleted and its
# tag cannot be moved — every such attempt answers HTTP 422. `gh release create`
# with assets is internally draft → upload → publish, and immutability engages
# only at publish, which is exactly the order GitHub documents for this. An
# `upload --clobber` pass against a release that is already public is not a
# slower path to the same place; it is a permanently red job.
#
# The corollary a caller has to respect: **a tag is never reused.** A tag name
# that carried an immutable release stays reserved even after the release is
# deleted, so "republish the same tag with new bytes" has no implementation.
#
# Every `gh` failure is fatal to the call so the workflow step sees it. Failure
# propagation is explicit (`|| return`) rather than errexit-based: a caller that
# wraps this in `if`/`&&`/`||` disables errexit for the whole function body.

# shellcheck source=retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/retry.sh"

# Prints `missing`, `draft` or `published` for a tag.
#
# A draft is the one recoverable state: it is still mutable, so a half-uploaded
# leftover from a failed attempt can be deleted and redone. `gh release view`
# reports a draft as happily as a published release, which is why this asks for
# `isDraft` rather than treating existence as completeness.
_release_state() {
  local tag="$1" state
  if ! state="$(gh release view "$tag" --json isDraft --jq 'if .isDraft then "draft" else "published" end' 2>/dev/null)"; then
    printf 'missing\n'
    return 0
  fi
  printf '%s\n' "$state"
}

# Fails unless every named asset is already attached to the published release.
#
# Existence of the release is not proof the last attempt finished: `gh` can die
# between the first uploaded asset and the publish call. Immutability makes that
# unrepairable, so it has to be reported rather than skipped over silently.
_assert_assets_published() {
  local tag="$1"
  shift

  local listing
  if ! listing="$(retry_command 3 30 gh release view "$tag" --json assets --jq '.assets[].name')"; then
    echo "Failed to list the assets already published on ${tag}" >&2
    return 1
  fi

  local path name missing=0
  for path in "$@"; do
    name="$(basename "$path")"
    if ! printf '%s\n' "$listing" | grep -Fxq "$name"; then
      echo "::error::${tag} is published without ${name}; immutable releases cannot be repaired, so cut the next version instead"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ]
}

publish_release() {
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
    echo "publish_release: at least one asset is required" >&2
    return 1
  fi
  if [ "$saw_separator" -eq 0 ]; then
    echo "publish_release: missing -- separator before gh release flags" >&2
    return 1
  fi

  local attempt=1
  local -r attempts=3
  local state
  while :; do
    state="$(_release_state "$tag")"
    case "$state" in
      published)
        echo "${tag} is already published; verifying its assets"
        _assert_assets_published "$tag" "${assets[@]}"
        return
        ;;
      draft)
        # A draft is always leftover: this helper never leaves one behind on a
        # successful call. Its assets may be incomplete, and a draft carries no
        # immutability, so deleting beats inspecting. The tag it may already
        # have created stays — `gh release create` reuses an existing tag, and
        # on the stable train the `release tags` ruleset refuses deleting one.
        echo "Deleting the leftover draft release for ${tag} before republishing"
        gh release delete "$tag" --yes --cleanup-tag=false || return
        ;;
    esac

    if gh release create "$tag" "${assets[@]}" "${flags[@]}"; then
      return 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "Failed to publish ${tag} after ${attempts} attempts" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 30
  done
}
