#!/usr/bin/env bash
# Auto-format files touched by Codex hooks using the repo-local Biome and dprint binaries.
set -uo pipefail

input=$(cat)
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

extract_file_path() {
  printf '%s' "$input" | jq -r '
    .tool_input.file_path //
    .tool_input.path //
    .file_path //
    .path //
    empty
  ' 2>/dev/null
}

file_path="$(extract_file_path)"

if [[ -z "${file_path}" || ! -f "${file_path}" ]]; then
  exit 0
fi

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
  (cd "${repo_root}" && "$@") >/dev/null 2>&1 || true
}

biome_bin="${repo_root}/node_modules/.bin/biome"
dprint_bin="${repo_root}/node_modules/.bin/dprint"
base_name="$(basename "${file_path}")"

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
    case "${base_name,,}" in
      dockerfile|dockerfile.*)
        if [[ -x "${dprint_bin}" ]]; then
          run "${dprint_bin}" fmt --allow-no-files "${file_path}"
        fi
        ;;
    esac
    ;;
esac

exit 0
