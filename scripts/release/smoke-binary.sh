#!/usr/bin/env bash
set -euo pipefail

binary_path="${1:-}"
expected_version="${2:-}"
port="${3:-13003}"

if [ -z "$binary_path" ] || [ -z "$expected_version" ]; then
  echo "Usage: scripts/release/smoke-binary.sh <binary> <expected-version> [port]" >&2
  exit 2
fi

if [ ! -f "$binary_path" ]; then
  echo "Binary not found: $binary_path" >&2
  exit 1
fi

binary_path="$(realpath "$binary_path")"
binary_dir="$(dirname "$binary_path")"
actual_version="$("$binary_path" --version)"

if [ "$actual_version" != "$expected_version" ]; then
  echo "Expected binary version ${expected_version}, got ${actual_version}" >&2
  exit 1
fi

# Source the shared boot/health helper relative to this script so the smoke
# works regardless of the caller's CWD.
# shellcheck source=wait-for-health.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wait-for-health.sh"

tmp_home="$(mktemp -d)"
server_log="${tmp_home}/mangostudio-smoke.log"
server_pid=""

cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp_home"
}
trap cleanup EXIT

(
  cd "$binary_dir"
  HOME="$tmp_home" \
    DATABASE_PATH="${tmp_home}/smoke.sqlite" \
    API_HOST=127.0.0.1 \
    API_PORT="$port" \
    BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-smoke-test-secret-at-least-32-characters-long}" \
    GEMINI_API_KEY="${GEMINI_API_KEY:-dummy}" \
    "$binary_path" serve "127.0.0.1:${port}" >"$server_log" 2>&1
) &
server_pid="$!"

# Short-circuit if the binary crashed before becoming healthy, otherwise wait
# for /api/health to report "ok" within the shared retry budget.
if ! wait_for_health "$port" "kill -0 $server_pid"; then
  echo "MangoStudio did not become healthy on port ${port}." >&2
  cat "$server_log" >&2 || true
  exit 1
fi

echo "MangoStudio ${expected_version} served /api/health successfully on port ${port}."
