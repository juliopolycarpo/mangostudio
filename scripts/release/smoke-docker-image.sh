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

# Checked after the removal above: a same-named container a killed run left up
# is cleared rather than reported, so only a foreign listener fails here.
# docker-proxy can hold the port briefly after the removal returns, so poll.
if command -v ss >/dev/null 2>&1; then
  listeners=""
  for _ in $(seq 1 5); do
    listeners="$(ss -H -ltn "( sport = :${port} )")"
    if [ -z "$listeners" ]; then
      break
    fi
    sleep 1
  done
  if [ -n "$listeners" ]; then
    echo "::error::expected smoke port ${port} released; listeners [$listeners]"
    exit 1
  fi
fi

docker run -d \
  --name "$container_name" \
  --platform "$platform" \
  -p "${port}:3001" \
  -e BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-smoke-test-secret-at-least-32-characters-long}" \
  -e GEMINI_API_KEY="${GEMINI_API_KEY:-dummy}" \
  "$image" >/dev/null

# Emulated (qemu) arm64 containers boot far slower than native amd64, so the
# default retry budget is generous. HEALTH_RETRIES lets CI override it.
if ! wait_for_health "$port" : 60; then
  echo "Docker image did not become healthy: ${image} (${platform})" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

if ! curl -fsS "http://localhost:${port}/" | grep -q '<html'; then
  echo "Docker image did not serve the frontend HTML: ${image} (${platform})" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

# Process-model checks. The images ship tini as PID 1 so orphaned processes are
# reaped and SIGTERM reaches the hub. Slim images carry no `ps`, so read /proc
# with POSIX sh and awk; both exist on Debian slim and on Alpine (busybox).
fail_with_logs() {
  echo "::error::$1: ${image} (${platform})" >&2
  docker logs "$container_name" >&2 || true
  exit 1
}

# One "<pid> <name> <state> <ppid>" line per process, as seen inside the container.
proc_snapshot_script="$(
  cat <<'SCRIPT'
for status in /proc/[0-9]*/status; do
  pid="${status#/proc/}"
  pid="${pid%/status}"
  awk -v pid="$pid" '/^Name:/ {n = $2} /^State:/ {s = $2} /^PPid:/ {p = $2} END {print pid, n, s, p}' "$status" 2>/dev/null || true
done
SCRIPT
)"

proc_snapshot() {
  docker exec "$container_name" sh -c "$proc_snapshot_script"
}

pid1_name="$(docker exec "$container_name" cat /proc/1/comm)"
if [ "$pid1_name" != "tini" ]; then
  fail_with_logs "expected PID 1 command: tini | received: ${pid1_name}"
fi

snapshot="$(proc_snapshot)"
if ! printf '%s\n' "$snapshot" | awk '$2 == "mangostudio" && $4 == 1 {found = 1} END {exit !found}'; then
  fail_with_logs "expected a mangostudio process with parent PID 1 (tini) | received: $(printf '%s' "$snapshot" | tr '\n' ';')"
fi

# Leave a short-lived orphan: its parent shell exits at once, so it is
# reparented to PID 1. The loop first requires seeing it alive under PID 1, so
# a missed spawn cannot pass as "reaped", then requires it to vanish rather
# than linger as a zombie.
docker exec -d "$container_name" sh -c 'sleep 3 & exit 0'
orphan_seen=0
orphan_reaped=0
for _ in $(seq 1 20); do
  snapshot="$(proc_snapshot)"
  if printf '%s\n' "$snapshot" | awk '$2 == "sleep" && $3 != "Z" && $4 == 1 {found = 1} END {exit !found}'; then
    orphan_seen=1
  elif [ "$orphan_seen" -eq 1 ] && ! printf '%s\n' "$snapshot" | awk '$2 == "sleep" {found = 1} END {exit !found}'; then
    orphan_reaped=1
    break
  fi
  sleep 1
done
if [ "$orphan_seen" -ne 1 ]; then
  fail_with_logs "expected an orphaned sleep reparented to PID 1 | received: $(printf '%s' "$snapshot" | tr '\n' ';')"
fi
if [ "$orphan_reaped" -ne 1 ]; then
  fail_with_logs "expected the orphaned sleep reaped within 20s | received: $(printf '%s' "$snapshot" | tr '\n' ';')"
fi
zombies="$(printf '%s\n' "$snapshot" | awk '$3 == "Z" {print $1 ":" $2}')"
if [ -n "$zombies" ]; then
  fail_with_logs "expected no zombie processes | received: ${zombies}"
fi

# `docker stop` sends SIGTERM to PID 1 (tini) and SIGKILLs after the timeout.
# A hub that handled SIGTERM exits 0; a hub that did not exits 137.
stop_started=$SECONDS
docker stop -t 10 "$container_name" >/dev/null
stop_seconds=$((SECONDS - stop_started))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$container_name")"
if [ "$exit_code" != "0" ]; then
  fail_with_logs "expected exit code 0 after SIGTERM | received: ${exit_code} after ${stop_seconds}s"
fi

echo "Docker image served /api/health and / and stopped cleanly on SIGTERM in ${stop_seconds}s: ${image} (${platform})"
