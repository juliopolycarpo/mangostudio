# LSP Navigation

This repository configures these OpenCode LSPs in `opencode.json`:

- `tsgo` for `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`
- `biome` for code diagnostics plus `.json`, `.jsonc`, `.css`, `.html`
- `dprint` for `.md`, `.mdx`, `.toml`, `.yml`, `.yaml`

OpenCode navigation rules for this repo:

1. Use `lsp` first for symbol work in TS or JS files.
2. Use `read` after LSP locates the relevant file and range.
3. Use `grep` for literals such as env vars, route paths, i18n keys, and generated text.
4. Use `glob` for file discovery only.

## Tool Priority

1. **`lsp` (semantic)** — first choice for symbol-level questions on `.ts/.tsx/.js/.jsx`. Routes to `tsgo`.
   - `hover` — types, signatures, JSDoc
   - `goToDefinition` — source of a symbol
   - `goToImplementation` — interface/abstract to concrete
   - `findReferences` — required **before** renaming, deleting, or changing any exported symbol
   - `documentSymbol` — file outline
   - `workspaceSymbol` — search a name across the monorepo
   - `prepareCallHierarchy` + `incomingCalls` / `outgoingCalls` — control flow
2. **`read`** — after LSP located the file/range. Read only the relevant slice.
3. **`grep`** — literal strings only: env vars, route paths, i18n keys, error messages, TODOs, dynamic identifiers.
4. **`glob`** — file discovery by path/extension. Never for symbols.

## Decision Table

| Question                                | Use                                      |
| --------------------------------------- | ---------------------------------------- |
| "Where is symbol X defined?"            | `workspaceSymbol` then `goToDefinition`  |
| "What references symbol X?"             | `findReferences`                         |
| "What implements interface X?"          | `goToImplementation`                     |
| "Who calls function X?"                 | `prepareCallHierarchy` + `incomingCalls` |
| "Find this string literal"              | `grep`                                   |
| "Find files matching this pattern"      | `glob`                                   |
| "Read a config/migration/markdown file" | `read` directly                          |

## Required Workflows

- **Understand a symbol**: `hover` -> `goToDefinition` -> `findReferences` -> `read` the relevant range.
- **Change a public API or shared type**: `goToDefinition` -> `findReferences` -> `goToImplementation` (if interface) -> edit all sites -> `bun run check`.
- **Remove or rename**: `findReferences` -> cross-check with `grep` for dynamic/string usages -> edit -> `bun run check`.
- **Analyze call flow**: `prepareCallHierarchy` -> `incomingCalls` / `outgoingCalls` -> fall back to `findReferences` if incomplete.

## Repo-Specific Tips

- **Elysia routes** — `hover` + `findReferences` on route files under `apps/api/src/modules/*/http/`.
- **TypeBox schemas** — `hover` on the schema constant to see inferred static type.
- **Kysely tables** — `goToDefinition` on the table interface in `apps/api/src/db/types.ts`.
- **Cross-package consumers** — `findReferences` on symbols exported from `@mangostudio/shared`.
- **Route strings, env vars, i18n keys, Tailwind classes** — `grep`.
- **Migrations, `.mango/*.toml`, `routeTree.gen.ts`** — `read` / `glob` only. Never edit `routeTree.gen.ts`.

## Practical Notes

- `tsgo` is the only semantic navigation source here.
- `biome` and `dprint` are not primary navigation tools.
- If a navigation request fails on Markdown, TOML, YAML, JSON, CSS, or HTML, fall back to `read` or `grep`.
- `hover` returns `null` at the definition site of a symbol; use it at usage sites for type/signature info.
- `goToImplementation` only applies to interfaces, abstract classes, and overridable members.
- `prepareCallHierarchy` requires a function/method definition site to work.
