#!/usr/bin/env bash
# Fails when a container the transport suite started is still known to the
# engine. --rm reaping is asynchronous, so the engine gets twenty seconds to
# finish before a leftover counts as a leak.
#
# Usage:
#   CONTAINER_CLI=podman scripts/release/assert-no-leftover-containers.sh
#
# Environment:
#   CONTAINER_CLI  Engine to ask: docker or podman.
set -euo pipefail

container_cli="${CONTAINER_CLI:-}"

case "$container_cli" in
  docker | podman) ;;
  *)
    echo "::error::expected CONTAINER_CLI: docker | podman | received: '${container_cli}'"
    exit 1
    ;;
esac

leftover=""
for ((poll = 0; poll < 20; poll++)); do
  leftover="$("$container_cli" ps -a --format '{{.Names}}' --filter 'name=mango-rt-')"
  if [ -z "$leftover" ]; then
    break
  fi
  sleep 1
done
if [ -n "$leftover" ]; then
  echo "::error::expected no mango-rt-* container left in ${container_cli} | received: ${leftover//$'\n'/ }"
  exit 1
fi
