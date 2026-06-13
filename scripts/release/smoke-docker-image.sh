#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
platform="${2:-}"
port="${3:-13002}"

if [ -z "$image" ] || [ -z "$platform" ]; then
  echo "Usage: scripts/release/smoke-docker-image.sh <image> <platform> [port]" >&2
  exit 2
fi

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

ready=0
for _ in $(seq 1 30); do
  response="$(curl -fsS "http://localhost:${port}/api/health" 2>/dev/null || true)"
  if printf '%s' "$response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
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
