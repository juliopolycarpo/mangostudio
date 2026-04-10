# Repository Guidelines

`AGENTS.md` is the canonical root instruction file for this repository.
Workspace-level `AGENTS.md` files must stay short and contain only workspace-specific deltas.

## Command Guidelines

1 - **Always assume/use**: `bun` or `bunx`
2 - **Never use**: `npm`, `npx`, `pnpm` or `yarn`

## Repo Map

- `apps/frontend/` — React 19 + Vite 8 UI with TanStack Router, TanStack Query, Better Auth client integration, and the local UI system.
- `apps/api/` — Elysia API with Better Auth, Kysely + SQLite persistence, connector management, and provider integrations.
- `apps/shared/` — shared contracts, domain types, i18n dictionaries, and framework-agnostic helpers.
- `tests/browser-smoke/` — Playwright smoke coverage for the auth flow.
- `.mango/` — example config, env overrides, local runtime artifacts, and standalone build output.

## Working Loop

1. Read this file, then only the relevant workspace `AGENTS.md`.
2. Start from the closest entrypoint to the task: route, component, hook, service, contract, or test.
3. Trace one layer outward at a time instead of scanning the whole repository.
4. Run the smallest relevant validation first, then expand only if the change is broad.
5. Open `docs/AGENT_PLAYBOOKS.md` only when a task needs deeper feature-by-feature navigation.

Useful docs:

- `README.md` — product and runtime overview
- `package.json` — root scripts
- `docs/TESTING.md` — test taxonomy and harness rules
- `docs/AGENT_PLAYBOOKS.md` — detailed file maps by feature area

## Global Rules

- Use Bun commands from the monorepo root.
- Keep changes scoped. Do not rewrite or reformat unrelated files.
- Never commit secrets, populated config files, databases, uploads, or build artifacts.
- Any frontend file that contains JSX must use the `.tsx` extension.
- All user-visible frontend strings must come from `@mangostudio/shared/i18n`.
- Public API shape changes must update the API code, shared contract, frontend consumer, and relevant tests in the same task.
- API error responses must use `ApiErrorResponse` from `@mangostudio/shared/contracts` or `SSEErrorEvent` from `@mangostudio/shared/contracts/errors`.
- Add new environment parsing only in `apps/api/src/lib/config.ts`.
- Shared code must remain framework-agnostic.
- Cross-workspace imports must use package names, never relative paths.
- Do not edit `apps/frontend/src/routeTree.gen.ts`; it is generated.

## Naming Shortcuts

- Migration files: `NNN_description.ts`
- i18n keys: dot-separated by feature scope
- DB tables: `snake_case`; DB columns: `camelCase`
- Kysely aliases: `<Entity>Select`, `<Entity>Insert`, `<Entity>Update`

## Task Routing

- Auth: `apps/api/src/auth.ts`, `apps/api/src/routes/auth.ts`, `apps/frontend/src/lib/auth-client.ts`, `apps/frontend/src/routes/login.tsx`, `apps/frontend/src/routes/signup.tsx`, `tests/browser-smoke/auth-flow.spec.ts`
- API route or contract: `apps/api/src/app.ts`, the target file under `apps/api/src/routes/`, `apps/shared/src/contracts/index.ts`, the matching frontend consumer, and relevant tests
- Chat, streaming, or generation: `apps/api/src/routes/respond.ts`, `apps/api/src/routes/respond-stream.ts`, `apps/api/src/routes/chats.ts`, `apps/api/src/routes/messages.ts`, `apps/frontend/src/hooks/use-text-chat.ts`, `apps/frontend/src/hooks/use-image-generation.ts`, `apps/frontend/src/services/generation-service.ts`
- Settings, connectors, or providers: `apps/api/src/routes/settings/`, `apps/api/src/services/providers/`, `apps/frontend/src/components/settings/`, `apps/frontend/src/hooks/use-model-catalog.ts`
- Persistence or migrations: `apps/api/src/db/database.ts`, `apps/api/src/db/types.ts`, `apps/api/src/db/migrations/`, and the owning service or route
- Shared i18n or types: `apps/shared/src/i18n/`, `apps/shared/src/contracts/`, `apps/shared/src/types/`, and the affected API/frontend consumers
- Config or standalone build: `apps/api/src/lib/config.ts`, `.mango/config.toml.example`, `.mango/.env.example`, `scripts/build.ts`

## Validation

After **every** change, run `bun run check`. If it fails, run `bun run fix` and re-check.
Before final handoff, run `bun run check && bun run test` to validate all workspaces.
