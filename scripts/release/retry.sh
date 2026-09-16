#!/usr/bin/env bash
# Shared release-workflow retry helper. Source this file, then call
# retry_command <attempts> <delay-seconds> <command> [args...].

retry_command() {
  local attempts="$1"
  local delay_seconds="$2"
  shift 2

  local attempt=1
  local status=0
  while true; do
    # Capture the command's real exit status: `if "$@"; then ...; fi` would leave
    # $? as the (always-zero) status of the if-compound, masking the failure.
    "$@" && return 0

    status="$?"
    if [ "$attempt" -ge "$attempts" ]; then
      return "$status"
    fi

    # stderr, not stdout: a caller may run this inside a command substitution to
    # capture the command's own output, and a retry notice mixed into that
    # output is indistinguishable from a result.
    echo "Attempt ${attempt}/${attempts} failed; retrying in ${delay_seconds}s: $*" >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done
}
