#!/usr/bin/env bash
set -euo pipefail

cat >/dev/null || true

cat <<'JSON'
{
  "hookSpecificOutput": {
    "additionalContext": "MangoStudio Codex repo config is active. Use bun or bunx only. Prefer bun run fix, bun run check, and bun run test. Biome owns JS, TS, TSX, JSON, CSS, and HTML formatting; dprint owns Markdown, MDX, TOML, YAML, and Dockerfiles; tsgo is the preferred TypeScript-native tool when a direct compiler-style check is needed."
  }
}
JSON
