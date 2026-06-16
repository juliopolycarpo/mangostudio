#!/usr/bin/env bash
# Shared crates.io publish-state probe. Source this file, then call
# `published <version>` to test whether <version> is already on crates.io.
#
# Reads CRATES_IO_INDEX_URL (the crate's sparse-index path) and
# CRATES_IO_USER_AGENT from the environment. Returns 0 when the version is
# already published, 1 when it is not, and exits non-zero (refusing to guess)
# when the sparse index cannot be reached or returns an unexpected status.
#
# Callers that want to tolerate an unreachable index (e.g. a post-publish
# visibility poll that should keep retrying) can invoke `published` inside a
# subshell, so its hard exit is contained and surfaces as a non-zero status.

published() {
  local version="$1"
  local found http_status index_response
  index_response="$(mktemp)"
  http_status="$(
    curl -sSL --retry 3 --retry-connrefused \
      --user-agent "$CRATES_IO_USER_AGENT" \
      --output "$index_response" \
      --write-out "%{http_code}" \
      "$CRATES_IO_INDEX_URL"
  )" || {
    rm -f "$index_response"
    echo "Failed to query crates.io sparse index; refusing to guess publish state." >&2
    exit 1
  }

  case "$http_status" in
    200)
      if grep -Fq "\"vers\":\"${version}\"" "$index_response"; then
        found=0
      else
        found=1
      fi
      ;;
    404)
      found=1
      ;;
    *)
      cat "$index_response" >&2
      rm -f "$index_response"
      echo "Unexpected crates.io sparse index response ${http_status}; refusing to guess publish state." >&2
      exit 1
      ;;
  esac
  rm -f "$index_response"
  return "$found"
}
