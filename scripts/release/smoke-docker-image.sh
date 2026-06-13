#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
platform="${2:-}"
port="${3:-13002}"

if [ -z "$image" ] || [ -z "$platform" ]; then
  echo "Usage: scripts/release/smoke-docker-image.sh <image> <platform> [port]" >&2
  exit 2
fi

# Source the shared boot/health helper relative to this script so the smoke
# works regardless of the caller's CWD.
# shellcheck source=wait-for-health.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wait-for-health.sh"

container_name="mangostudio-smoke-${platform//\//-}-${port}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup

docker run -d \
  --name "$container_name" \
  --platform "$platform" \
  -p "${port}:3001" \
  -e BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-smoke-test-secret-at-least-32-characters-long}" \
  -e GEMINI_API_KEY="${GEMINI_API_KEY:-dummy}" \
  "$image" >/dev/null

# Emulated (qemu) arm64 containers boot far slower than native amd64, so the
# default retry budget is generous. HEALTH_RETRIES lets CI override it.
if ! wait_for_health "$port" : "${HEALTH_RETRIES:-60}"; then
  echo "Docker image did not become healthy: ${image} (${platform})" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

if ! curl -fsS "http://localhost:${port}/" | grep -q '<html'; then
  echo "Docker image did not serve the frontend HTML: ${image} (${platform})" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

echo "Docker image served /api/health and / successfully: ${image} (${platform})"
