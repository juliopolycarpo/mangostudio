#!/usr/bin/env bash
# Delete old canary GitHub pre-releases (and their tags), keeping the most recent
# KEEP. Canary pre-releases exist only to host the platform archives the cargo
# launcher downloads (the shim resolves .../releases/download/v<version>/), so
# bounding them keeps the releases page and tag list manageable. crates.io
# versions are permanent and are never pruned here.
#
# Usage: GH_TOKEN=... prune-canary-releases.sh [keep=10]
set -euo pipefail

keep="${1:-10}"

mapfile -t tags < <(
  gh release list --limit 200 --json tagName,createdAt,isPrerelease \
    --jq '[.[] | select(.isPrerelease and (.tagName | test("-canary")))]
          | sort_by(.createdAt) | reverse | .[].tagName'
)

if [ "${#tags[@]}" -le "$keep" ]; then
  echo "Found ${#tags[@]} canary pre-release(s); nothing to prune (keep=${keep})."
  exit 0
fi

for tag in "${tags[@]:$keep}"; do
  echo "Pruning canary pre-release ${tag}"
  gh release delete "$tag" --cleanup-tag --yes || echo "Failed to delete ${tag}; continuing."
done
