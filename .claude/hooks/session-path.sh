#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CLAUDE_ENV_FILE:-}" || -z "${CLAUDE_PROJECT_DIR:-}" ]]; then
  exit 0
fi

repo_bin="${CLAUDE_PROJECT_DIR}/node_modules/.bin"
if [[ ! -d "${repo_bin}" ]]; then
  exit 0
fi

printf 'export PATH="%s:$PATH"\n' "${repo_bin}" >"${CLAUDE_ENV_FILE}"
