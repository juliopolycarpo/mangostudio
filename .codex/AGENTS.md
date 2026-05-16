# Codex Repo Notes

- The repository root `AGENTS.md` remains the canonical instruction file.
- This `.codex/AGENTS.md` only adds Codex-local deltas for MangoStudio.
- Use `bun` and `bunx` only. Do not use `node`, `npm`, `npx`, `pnpm`, or `yarn`.
- Prefer the repo entrypoints for validation: `bun run fix`, `bun run check`, and `bun run test`.
- Treat Biome as the formatter and linter for JS, TS, TSX, JSON, CSS, and HTML.
- Treat dprint as the formatter for Markdown, MDX, TOML, YAML, and Dockerfiles.
- Prefer `tsgo` for TypeScript-native checks when a direct compiler command is needed.
