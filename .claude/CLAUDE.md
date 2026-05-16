# CLAUDE.md

Claude Code-specific guidance for this repository.
`AGENTS.md` (at the repo root) is the canonical source of truth for structure,
task routing, and global rules. This file only documents what is specific to
Claude Code: command guidelines, the local plugin loadout, and the code
navigation workflow.

## Command Guidelines

1. **Always use**: `bun` or `bunx`.
2. **Never use**: `npm`, `npx`, `pnpm`, or `yarn`.
3. Run commands from the monorepo root unless a workspace `AGENTS.md` says
   otherwise.

## Validation Loop

After **every** change:

```bash
bun run check       # biome + tsgo + dprint + workspace checks
```

If it fails, run `bun run fix` and re-check. Before final handoff:

```bash
bun run check && bun run test
```

## Local Plugins

This project ships a private Claude Code marketplace under
`.claude/marketplaces/mangostudio-local/` so every contributor uses the same
LSP toolchain as the repo binaries. All three are enabled in
`.claude/settings.json` and shadow the upstream `typescript-lsp` / `web-lsp`
plugins.

| Plugin                   | Binary                       | Handles                                                      | Surfaces                                                                                                                                       |
| ------------------------ | ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mangostudio-tsgo-lsp`   | `tsgo` (`node_modules/.bin`) | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | Full code intelligence: `hover`, `goToDefinition`, `findReferences`, `goToImplementation`, `documentSymbol`, `workspaceSymbol`, call hierarchy |
| `mangostudio-biome-lsp`  | `biome lsp-proxy`            | `.js/.ts/.jsx/.tsx`, `.json`, `.jsonc`, `.css`, `.html`      | Diagnostics and quick-fixes. Navigation methods return `Method not found` — that is expected                                                   |
| `mangostudio-dprint-lsp` | `dprint lsp`                 | `.md`, `.mdx`, `.toml`, `.yml`, `.yaml`                      | Formatting diagnostics only. No navigation methods                                                                                             |

### Hooks

- `SessionStart` / `CwdChanged` — `.claude/hooks/session-path.sh` prepends
  `node_modules/.bin` to `PATH` so `tsgo`/`biome`/`dprint` resolve to the
  repo-pinned versions.
- `PostToolUse` on `Edit|Write|MultiEdit` — `.claude/hooks/auto-fix.sh`
  auto-formats the touched file (Biome for JS/TS/JSON/CSS/HTML, dprint for
  MD/MDX/TOML/YAML/Dockerfile). The hook is silent and never aborts the flow.

### Quick self-check

If LSP feels broken, run from the repo root:

```bash
bun run check                                              # toolchain sanity
node_modules/.bin/tsgo --version                           # tsgo binary
node_modules/.bin/biome --version                          # biome binary
node_modules/.bin/dprint --version                         # dprint binary
```

If a binary is missing, run `bun install`. If a plugin is not loading, check
`enabledPlugins` in `.claude/settings.json` and reload with `/reload-plugins`.

## Code Navigation

The repo is a Bun + TypeScript monorepo with cross-package imports via path
aliases (`@mangostudio/*`). Prefer LSP semantic navigation over text search.

### Tool priority

1. **`LSP` (semantic)** — first choice for any symbol-level question on
   `.ts/.tsx/.js/.jsx` files. Routes to `tsgo`.
   - `hover` — types, signatures, JSDoc
   - `goToDefinition` — source of a symbol
   - `goToImplementation` — interface or abstract → concrete
   - `findReferences` — required **before** renaming, deleting, or changing
     any exported symbol
   - `documentSymbol` — file outline
   - `workspaceSymbol` — search a name across the monorepo
   - `prepareCallHierarchy` + `incomingCalls` / `outgoingCalls` — control
     flow analysis
2. **`Read`** — after LSP located the file/range. Read only the relevant
   slice, never the whole file when the range is known.
3. **`Grep`** — literal strings only: env var names, route paths, i18n keys,
   error messages, TODOs, dynamic identifiers, post-refactor safety sweeps.
4. **`Glob`** — file discovery by path/extension. Never for symbols.

### When to use what

| Question                                | Use                                             |
| --------------------------------------- | ----------------------------------------------- |
| "Where is symbol X defined?"            | `LSP.workspaceSymbol` then `LSP.goToDefinition` |
| "What references symbol X?"             | `LSP.findReferences`                            |
| "What implements interface X?"          | `LSP.goToImplementation`                        |
| "Who calls function X?"                 | `LSP.prepareCallHierarchy` + `incomingCalls`    |
| "Find this string literal"              | `Grep`                                          |
| "Find files matching this pattern"      | `Glob`                                          |
| "Read a config/migration/markdown file" | `Read` directly                                 |

### Required workflows

- **Understand a symbol**: `hover` → `goToDefinition` → `findReferences` →
  `Read` the relevant range.
- **Change a public API or shared type**: `goToDefinition` → `findReferences`
  → `goToImplementation` (if interface) → edit all sites → `bun run check`.
- **Remove or rename**: `findReferences` → cross-check with `Grep` for
  dynamic/string usages → edit → `bun run check`.
- **Analyze call flow**: `prepareCallHierarchy` → `incomingCalls` /
  `outgoingCalls` → fall back to `findReferences` if hierarchy is incomplete.

### Repo-specific tips

- **Elysia routes**, decorators, and context types — `hover` +
  `findReferences` on the route file under `apps/api/src/modules/*/http/`.
- **TypeBox schemas** — `hover` on the schema constant to see the inferred
  static type.
- **Kysely tables** — `goToDefinition` on the table interface in
  `apps/api/src/db/types.ts`; treat `<Entity>Select/Insert/Update` aliases as
  the canonical type names.
- **Cross-package consumers** — `findReferences` on a symbol exported from
  `@mangostudio/shared` to trace every API/frontend usage.
- **Route strings, env vars, i18n keys, Tailwind classes** — `Grep`.
- **Migrations, `.mango/*.toml`, `routeTree.gen.ts`** — `Read` / `Glob` only.
  Never edit `routeTree.gen.ts`; it is generated.

## Trust AGENTS.md

`AGENTS.md` is the source of truth for the repo map, task routing, naming
shortcuts, and global rules. Read it before anything else.

@../AGENTS.md
