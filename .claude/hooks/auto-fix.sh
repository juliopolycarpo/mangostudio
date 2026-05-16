#!/usr/bin/env bash
# Auto-fix files touched by Claude Code (PostToolUse: Write|Edit|MultiEdit).
# Routes by extension: Biome (JS/TS/JSON/CSS/HTML) and dprint (MD/MDX/TOML/YAML/Dockerfile).
# Always exits 0 so a tool/format issue never aborts Claude's flow.
set -uo pipefail

input=$(cat)

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)

if [[ -z "${file_path}" || ! -f "${file_path}" ]]; then
  exit 0
fi

# Stay inside the repo this hook lives in.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "${file_path}" in
  "${repo_root}"/*) ;;
  *) exit 0 ;;
esac

case "${file_path}" in
  */node_modules/*|*/dist/*|*/coverage/*|*/.mango/out/*|*/playwright-report/*|*/test-results/*|*/.tsbuildinfo|*/bun.lock|*/routeTree.gen.ts)
    exit 0
    ;;
esac

run() {
  ( cd "${repo_root}" && "$@" ) >/dev/null 2>&1 || true
}

biome_bin="${repo_root}/node_modules/.bin/biome"
dprint_bin="${repo_root}/node_modules/.bin/dprint"

base=$(basename "${file_path}")
case "${file_path,,}" in
  *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts|*.json|*.jsonc|*.css|*.html)
    if [[ -x "${biome_bin}" ]]; then
      run "${biome_bin}" check --write --no-errors-on-unmatched --files-ignore-unknown=true "${file_path}"
    fi
    ;;
  *.md|*.mdx|*.toml|*.yml|*.yaml)
    if [[ -x "${dprint_bin}" ]]; then
      run "${dprint_bin}" fmt --allow-no-files "${file_path}"
    fi
    ;;
  *)
    case "${base,,}" in
      dockerfile|dockerfile.*)
        if [[ -x "${dprint_bin}" ]]; then
          run "${dprint_bin}" fmt --allow-no-files "${file_path}"
        fi
        ;;
    esac
    ;;
esac

exit 0
