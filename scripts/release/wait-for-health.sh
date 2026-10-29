#!/usr/bin/env bash
# Polls a MangoStudio server's /api/health endpoint until it reports
# {"status":"ok"} or the retry budget is exhausted. Shared by the binary
# and Docker smoke scripts so the boot/health loop lives in one place.
#
# Bash's SECONDS clock has whole-second resolution. A request can settle less
# than one second after the nominal budget, plus scheduling delay. Every curl
# uses the remaining deadline; retries never reset that deadline.
#
# Usage: wait_for_health <port> [alive_check] [retries]
#
# Arguments:
#   port          Localhost port the server is bound to.
#   alive_check   Optional shell expression re-evaluated each iteration;
#                 a non-zero exit short-circuits with return 2 so the caller
#                 can surface the host-side failure (crashed process, missing
#                 container, ...). Defaults to ":" (always true).
#   retries       Maximum poll iterations and nominal total seconds. Defaults to 30.
#                 Overridable via HEALTH_RETRIES for emulated arm64 boots.
#
# Returns:
#   0  Server reported "status":"ok" in time.
#   1  Retry budget exhausted without a healthy response.
#   2  An argument is invalid or alive_check reported the host process is gone.
#
# Environment:
#   HEALTH_RETRIES  Overrides the [retries] argument when set.

# No top-level `set` here: this file is only ever sourced, and a sourced helper
# must not mutate the caller's shell options. The callers already enable strict
# mode, and the function below is nounset-safe and uses explicit returns.

# Only define the function if it has not been provided by a more specific
# caller; sourcing this file twice (e.g. from a test harness) stays a no-op.
if ! declare -F wait_for_health >/dev/null 2>&1; then
  wait_for_health() {
    local port="${1:-}"
    local alive_check="${2:-:}"
    local retries="${HEALTH_RETRIES:-${3:-30}}"

    if [ -z "$port" ]; then
      echo "wait_for_health: missing <port>" >&2
      return 2
    fi

    # Bound decimal input before arithmetic; Bash treats leading zeroes as octal.
    if [[ ! "$retries" =~ ^[0-9]+$ ]] || [ "${#retries}" -gt 10 ] ||
      [ "$retries" -lt 1 ] || [ "$retries" -gt 2147483647 ]; then
      printf 'wait_for_health: expected retries: integer in 1..2147483647 | received: %s\n' "$retries" >&2
      return 2
    fi
    retries=$((10#$retries))

    # SECONDS is available in Bash 3.2; do not reset the caller's clock.
    local deadline=$((SECONDS + retries))
    local attempt remaining response
    for ((attempt = 0; attempt < retries; attempt += 1)); do
      remaining=$((deadline - SECONDS))
      if [ "$remaining" -le 0 ]; then
        return 1
      fi
      if ! eval "$alive_check" >/dev/null 2>&1; then
        return 2
      fi
      remaining=$((deadline - SECONDS))
      if [ "$remaining" -le 0 ]; then
        return 1
      fi

      if response="$(curl -fsS --max-time "$remaining" "http://localhost:${port}/api/health" 2>/dev/null)" &&
        [ "$SECONDS" -lt "$deadline" ]; then
        if printf '%s' "$response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
          return 0
        fi
      fi
      # There is no next poll after the final attempt. A whole-second sleep
      # also needs a whole second left for that next poll, rather than adding
      # another second after a slow request consumed the readiness budget.
      remaining=$((deadline - SECONDS))
      if [ "$((attempt + 1))" -ge "$retries" ] || [ "$remaining" -le 1 ]; then
        return 1
      fi
      sleep 1
    done

    return 1
  }
fi
