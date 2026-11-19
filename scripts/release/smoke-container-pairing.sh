#!/usr/bin/env bash
# Proves one container transport pairing: an engine, a base image and the
# runtime binary built for that image's libc. It prepares the image first, so
# a registry failure fails the step instead of looking like a skipped suite,
# then runs the container transport suite against it.
#
# Usage, from apps/api:
#   CONTAINER_CLI=docker \
#   BASE_IMAGE=alpine:3 \
#   PACKAGES="bash libstdc++" \
#   MANGO_CONTAINER_E2E_IMAGE=mango-container-smoke:musl \
#   MANGO_CONTAINER_E2E_RUNTIME=/abs/.mango/out/linux-x64-musl/mangostudio-runtime \
#     ../../scripts/release/smoke-container-pairing.sh
#
# Environment:
#   CONTAINER_CLI                Engine for image preparation and suite: docker or podman.
#   BASE_IMAGE                   Image an ordinary user would pick for this libc.
#   PACKAGES                     apk packages the base image lacks. Empty tags
#                                the base image unchanged.
#   MANGO_CONTAINER_E2E_IMAGE    Tag the suite starts its containers from.
#   MANGO_CONTAINER_E2E_RUNTIME  Absolute path of the runtime binary to mount.
#
# The helper exports MANGO_CONTAINER_E2E_ENGINE from validated CONTAINER_CLI so
# image preparation and the suite use the same engine.
set -euo pipefail

container_cli="${CONTAINER_CLI:-}"
base_image="${BASE_IMAGE:-}"
packages="${PACKAGES:-}"
# The suite reads these two by name, so they keep it here as well. Defaulting
# them lets an unset one reach the checks below instead of tripping nounset.
MANGO_CONTAINER_E2E_IMAGE="${MANGO_CONTAINER_E2E_IMAGE:-}"
MANGO_CONTAINER_E2E_RUNTIME="${MANGO_CONTAINER_E2E_RUNTIME:-}"

fail() {
  echo "::error::$1"
  exit 1
}

case "$container_cli" in
  docker | podman) ;;
  *) fail "expected CONTAINER_CLI: docker | podman | received: '${container_cli}'" ;;
esac
export MANGO_CONTAINER_E2E_ENGINE="$container_cli"
if [ -z "$base_image" ]; then
  fail "expected BASE_IMAGE: an image reference such as debian:bookworm-slim | received: '${base_image}'"
fi
if [ -z "$MANGO_CONTAINER_E2E_IMAGE" ]; then
  fail "expected MANGO_CONTAINER_E2E_IMAGE: a tag such as mango-container-smoke:glibc | received: '${MANGO_CONTAINER_E2E_IMAGE}'"
fi

if [ -z "$packages" ]; then
  "$container_cli" pull "$base_image"
  "$container_cli" tag "$base_image" "$MANGO_CONTAINER_E2E_IMAGE"
else
  printf 'FROM %s\nRUN apk add --no-cache %s\n' "$base_image" "$packages" \
    | "$container_cli" build -t "$MANGO_CONTAINER_E2E_IMAGE" -
fi
if [ ! -x "$MANGO_CONTAINER_E2E_RUNTIME" ]; then
  fail "expected MANGO_CONTAINER_E2E_RUNTIME: path of an executable runtime binary | received: '${MANGO_CONTAINER_E2E_RUNTIME}'"
fi
"$container_cli" image inspect "$MANGO_CONTAINER_E2E_IMAGE" >/dev/null

suite=(bun test tests/integration/services/connect-container-runtime.integration.test.ts)
# MANGOSTUDIO_REAL_HOME is set when a launcher already started this script.
if [ -n "${MANGOSTUDIO_REAL_HOME:-}" ]; then
  "${suite[@]}"
  exit
fi

# The API test preload refuses a run on the real home, so only the suite starts
# under the temporary-HOME launcher; the engine commands above ran with the real
# environment. The launcher moves HOME and every XDG_* root, which breaks a
# rootless engine (podman's build needs the real XDG_RUNTIME_DIR for its
# systemd/cgroup session and keeps its image store under XDG_DATA_HOME), so the
# suite's own engine calls get the real engine roots back through `env`, which
# runs inside the launcher and wins over its overrides. HOME stays the scratch
# one, which is all the preload checks. VERSION is kept: the mounted release
# runtime and the hub must report the same one.
engine_env=(
  "XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}"
  "XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}"
  "DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker}"
)
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  engine_env+=("XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR")
fi
exec bun "$(dirname "${BASH_SOURCE[0]}")/../with-test-home.ts" --keep-build-version \
  env "${engine_env[@]}" "${suite[@]}"
