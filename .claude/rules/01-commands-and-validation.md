# Commands and Validation

1. **Always use**: `bun` or `bunx`.
2. **Never use**: `npm`, `npx`, `pnpm`, or `yarn`.
3. Run commands from the monorepo root unless a workspace `AGENTS.md` says otherwise.

## Validation Loop

After **every** change:

```bash
bun run check       # biome + tsgo + dprint + workspace checks
```

If it fails, run `bun run fix` and re-check. Before final handoff:

```bash
bun run check && bun run test
```
