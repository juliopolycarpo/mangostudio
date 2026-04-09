# CLAUDE.md

## Command Guidelines

1 - **Always assume/use**: `bun` or `bunx`
2 - **Never use**: `npm`, `npx`, `pnpm` or `yarn`

## Validation

After **every** change, run `bun run check`. If it fails, run `bun run fix` and re-check.
Before final handoff, run `bun run check && bun run test` to validate all workspaces.

**IMPORTANT**: Treat `AGENTS.md` as the source of truth for repository structure and content.

@AGENTS.md
