#!/usr/bin/env bash
# Polls a MangoStudio server's /api/health endpoint until it reports
# {"status":"ok"} or the retry budget is exhausted. Shared by the binary
# and Docker smoke scripts so the boot/health loop lives in one place.
#
# Usage: wait_for_health <port> [alive_check] [retries]
#
# Arguments:
#   port          Localhost port the server is bound to.
#   alive_check   Optional shell expression re-evaluated each iteration;
#                 a non-zero exit short-circuits with return 2 so the caller
#                 can surface the host-side failure (crashed process, missing
#                 container, ...). Defaults to ":" (always true).
#   retries       Maximum poll iterations, one per second. Defaults to 30.
#                 Overridable via HEALTH_RETRIES for emulated arm64 boots.
#
# Returns:
#   0  Server reported "status":"ok" in time.
#   1  Retry budget exhausted without a healthy response.
#   2  alive_check reported the host process is gone.
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

    for _ in $(seq 1 "$retries"); do
      if ! eval "$alive_check" >/dev/null 2>&1; then
        return 2
      fi

      local response
      response="$(curl -fsS "http://localhost:${port}/api/health" 2>/dev/null || true)"
      if printf '%s' "$response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
        return 0
      fi
      sleep 1
    done

    return 1
  }
fi
