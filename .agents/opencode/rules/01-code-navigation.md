# OpenCode Code Navigation

- Use `lsp` first for symbol work in `.ts`, `.tsx`, `.js`, and `.jsx`.
- Use `read` after `lsp` has located the relevant file and range.
- Use `grep` for literals such as route paths, env vars, i18n keys, generated text, and error messages.
- Use `glob` only for file discovery by path or extension.

Preferred flow:

1. `workspaceSymbol` or `documentSymbol` to locate the symbol.
2. `goToDefinition` or `goToImplementation` to reach the source.
3. `findReferences` before changing exported symbols, shared types, or public APIs.
4. `read` only the relevant slice once the target is known.

Repo-specific shortcuts:

- API routes: `apps/api/src/modules/*/http/`
- Shared contracts and i18n: `apps/shared/src/`
- Frontend routes, hooks, and consumers: `apps/frontend/src/`
- Route strings, prompt text, and config values: prefer `grep`
- Generated files such as `apps/frontend/src/routeTree.gen.ts`: inspect only, do not edit
