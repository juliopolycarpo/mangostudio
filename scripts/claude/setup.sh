#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
marketplace_dir="${repo_root}/.claude/marketplaces/mangostudio-local"

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "${name}" >&2
    exit 1
  fi
}

ensure_marketplace() {
  if claude plugin marketplace list | grep -Fq "mangostudio-local"; then
    printf 'Marketplace already registered: mangostudio-local\n'
    return
  fi

  claude plugin marketplace add --scope project "${marketplace_dir}"
}

ensure_plugin() {
  local plugin_ref="$1"

  if claude plugin list | grep -Fq "${plugin_ref}"; then
    printf 'Plugin already installed: %s\n' "${plugin_ref}"
    return
  fi

  claude plugin install "${plugin_ref}" --scope project
}

main() {
  require_command claude

  cd "${repo_root}"

  ensure_marketplace
  ensure_plugin "mangostudio-tsgo-lsp@mangostudio-local"
  ensure_plugin "mangostudio-biome-lsp@mangostudio-local"
  ensure_plugin "mangostudio-dprint-lsp@mangostudio-local"

  printf '\nProject Claude Code setup is ready.\n'
  claude plugin list
}

main "$@"
