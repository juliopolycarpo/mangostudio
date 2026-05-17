# Formatters And Checks

This repository wires OpenCode formatters through `opencode.json`:

- `biome-fix` formats JS, TS, JSON, CSS, and HTML files.
- `dprint-fmt` formats Markdown, TOML, and YAML files.
- Prettier is disabled in local OpenCode config.

Operational rules:

1. Prefer OpenCode's configured formatter for touched files instead of introducing formatter-specific ad hoc commands.
2. Run validation from the monorepo root with `bun run check` after changes.
3. If toolchain verification is needed, check `./node_modules/.bin/tsgo`, `./node_modules/.bin/biome`, and `./node_modules/.bin/dprint`.
