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
actual_version="$("$binary_path" --version)"

if [ "$actual_version" != "$expected_version" ]; then
  echo "Expected binary version ${expected_version}, got ${actual_version}" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

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

# Regression for the stale-sidecar bug: run a copy of the binary from a staging
# directory that carries a doctored `public/` beside it. The frontend is
# embedded in the executable, so the stale sidecar must be provably ignored.
# (A copy — not a symlink — because the server resolves its own realpath.)
stale_sentinel="STALE-PUBLIC-SENTINEL-$$"
staging_dir="${tmp_home}/staging"
mkdir -p "${staging_dir}/public/assets"
cp "$binary_path" "${staging_dir}/"
staged_binary="${staging_dir}/$(basename "$binary_path")"
chmod +x "$staged_binary" 2>/dev/null || true
printf '<html><body>%s</body></html>\n' "$stale_sentinel" >"${staging_dir}/public/index.html"
printf 'console.log("%s")\n' "$stale_sentinel" >"${staging_dir}/public/assets/index-stale0000.js"

(
  cd "$staging_dir"
  HOME="$tmp_home" \
    DATABASE_PATH="${tmp_home}/smoke.sqlite" \
    API_HOST=127.0.0.1 \
    API_PORT="$port" \
    BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-smoke-test-secret-at-least-32-characters-long}" \
    GEMINI_API_KEY="${GEMINI_API_KEY:-dummy}" \
    "$staged_binary" serve "127.0.0.1:${port}" >"$server_log" 2>&1
) &
server_pid="$!"

# Wait for /api/health to report "ok" within the shared retry budget, short-
# circuiting if the binary crashed first. The helper returns 2 when the process
# exited and 1 when the health budget was exhausted; surface them distinctly.
boot_status=0
wait_for_health "$port" "kill -0 $server_pid" || boot_status=$?
if [ "$boot_status" -ne 0 ]; then
  if [ "$boot_status" -eq 2 ]; then
    echo "MangoStudio exited before becoming healthy." >&2
  else
    echo "MangoStudio did not become healthy on port ${port}." >&2
  fi
  cat "$server_log" >&2 || true
  exit 1
fi

# The served UI shell must come from the embedded assets, never the planted
# stale sidecar.
served_index="${tmp_home}/served-index.html"
curl -fsS "http://localhost:${port}/" -o "$served_index"
if grep -q "$stale_sentinel" "$served_index"; then
  echo "Served index.html came from the stale public/ sidecar." >&2
  exit 1
fi

# The bundle referenced by the served index must resolve from the embedded set
# (the stale sidecar only contains the doctored bundle name).
asset_path="$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$served_index" | head -n 1 || true)"
if [ -z "$asset_path" ]; then
  echo "Served index.html references no /assets/*.js bundle." >&2
  cat "$served_index" >&2
  exit 1
fi
served_asset="${tmp_home}/served-asset.js"
curl -fsS "http://localhost:${port}${asset_path}" -o "$served_asset"
if grep -q "$stale_sentinel" "$served_asset"; then
  echo "Served bundle ${asset_path} came from the stale public/ sidecar." >&2
  exit 1
fi

# When the freshly built frontend dist is available (same-job smokes), the
# served shell must match it byte-for-byte.
dist_index="${repo_root}/apps/frontend/dist/index.html"
if [ -f "$dist_index" ]; then
  served_hash="$(sha256sum "$served_index" | cut -d' ' -f1)"
  dist_hash="$(sha256sum "$dist_index" | cut -d' ' -f1)"
  if [ "$served_hash" != "$dist_hash" ]; then
    echo "Served index.html (${served_hash}) differs from built dist (${dist_hash})." >&2
    exit 1
  fi
  echo "Served index.html matches apps/frontend/dist (${dist_hash})."
fi

echo "MangoStudio ${expected_version} served /api/health, / and ${asset_path} from embedded assets on port ${port}."
