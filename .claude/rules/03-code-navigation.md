# Code Navigation

Bun + TypeScript monorepo with cross-package imports via `@mangostudio/*`. Prefer LSP semantic navigation over text search.

## Tool Priority

1. **`LSP` (semantic)** — first choice for symbol-level questions on `.ts/.tsx/.js/.jsx`. Routes to `tsgo`.
   - `hover` — types, signatures, JSDoc
   - `goToDefinition` — source of a symbol
   - `goToImplementation` — interface/abstract to concrete
   - `findReferences` — required **before** renaming, deleting, or changing any exported symbol
   - `documentSymbol` — file outline
   - `workspaceSymbol` — search a name across the monorepo
   - `prepareCallHierarchy` + `incomingCalls` / `outgoingCalls` — control flow
2. **`Read`** — after LSP located the file/range. Read only the relevant slice.
3. **`Grep`** — literal strings only: env vars, route paths, i18n keys, error messages, TODOs, dynamic identifiers.
4. **`Glob`** — file discovery by path/extension. Never for symbols.

## Decision Table

| Question                                | Use                                             |
| --------------------------------------- | ----------------------------------------------- |
| "Where is symbol X defined?"            | `LSP.workspaceSymbol` then `LSP.goToDefinition` |
| "What references symbol X?"             | `LSP.findReferences`                            |
| "What implements interface X?"          | `LSP.goToImplementation`                        |
| "Who calls function X?"                 | `LSP.prepareCallHierarchy` + `incomingCalls`    |
| "Find this string literal"              | `Grep`                                          |
| "Find files matching this pattern"      | `Glob`                                          |
| "Read a config/migration/markdown file" | `Read` directly                                 |

## Required Workflows

- **Understand a symbol**: `hover` -> `goToDefinition` -> `findReferences` -> `Read` the relevant range.
- **Change a public API or shared type**: `goToDefinition` -> `findReferences` -> `goToImplementation` (if interface) -> edit all sites -> `bun run check`.
- **Remove or rename**: `findReferences` -> cross-check with `Grep` for dynamic/string usages -> edit -> `bun run check`.
- **Analyze call flow**: `prepareCallHierarchy` -> `incomingCalls` / `outgoingCalls` -> fall back to `findReferences` if incomplete.

## Repo-Specific Tips

- **Elysia routes** — `hover` + `findReferences` on route files under `apps/api/src/modules/*/http/`.
- **TypeBox schemas** — `hover` on the schema constant to see inferred static type.
- **Kysely tables** — `goToDefinition` on the table interface in `apps/api/src/db/types.ts`.
- **Cross-package consumers** — `findReferences` on symbols exported from `@mangostudio/shared`.
- **Route strings, env vars, i18n keys, Tailwind classes** — `Grep`.
- **Migrations, `.mango/*.toml`, `routeTree.gen.ts`** — `Read` / `Glob` only. Never edit `routeTree.gen.ts`.
