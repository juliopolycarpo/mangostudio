# API Workspace Guidance

Read `../../AGENTS.md` first. This file only adds API-local entrypoints, invariants, and tests.

## Start Here

- App and prefix: `src/app.ts`
- Auth: `src/auth.ts`, `src/routes/auth.ts`, `src/plugins/auth-middleware.ts`
- Routes: `src/routes/`
- Config and runtime: `src/lib/config.ts`, `src/index.ts`
- Persistence: `src/db/database.ts`, `src/db/types.ts`, `src/db/migrations/`
- Providers, secrets, and tools: `src/services/providers/`, `src/services/secret-store/`, `src/services/tools/`

## Diagnose By Task

- Route or endpoint: the target file under `src/routes/`, `src/app.ts`, `apps/shared/src/contracts/index.ts`, the matching frontend consumer, and the relevant integration test
- Auth: `src/auth.ts`, `src/routes/auth.ts`, `src/plugins/auth-middleware.ts`, `apps/frontend/src/lib/auth-client.ts`, `tests/browser-smoke/auth-flow.spec.ts`
- Chat or streaming: `src/routes/respond.ts`, `src/routes/respond-stream.ts`, `src/routes/chats.ts`, `src/routes/messages.ts`, `src/services/chat-service.ts`, `src/services/message-service.ts`
- Connectors or providers: `src/routes/settings/`, `src/services/providers/`, `src/services/secret-store/`, `src/lib/config.ts`
- Persistence or migrations: `src/db/database.ts`, `src/db/types.ts`, `src/db/row-types.ts`, `src/db/migrations/`, and the owning service or route

## API Rules

- Route plugins define their own `.group('/path', ...)` paths without the `/api` prefix.
- Keep request and response schemas explicit, and reuse shared contracts for public shapes.
- Prefer Kysely builder in application code. Use `kysely/sql` only when a migration or SQLite edge requires it.
- Reuse config, secret-store, and provider abstractions before adding new env parsing or credential logic.
- Keep auth, connector, and provider errors explicit and logged with context.

## Tests

- Unit: `bun run --filter @mangostudio/api test:unit`
- Integration: `bun run --filter @mangostudio/api test:integration`
- Integration tests must use `apps/api/tests/support/harness/create-api-test-app.ts`.
- Integration test URLs use the plugin group path directly, without `/api`.
- Validate public response shapes with `Value.Check(Schema, payload)` when the contract matters.
