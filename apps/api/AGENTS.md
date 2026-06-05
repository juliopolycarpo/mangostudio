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

### Preload await gotcha

`apps/api/tests/support/setup/preload.ts` runs before any test module. **Do not place
synchronous-required initialization after the first `await` in the preload.** Bun does
NOT block test module loading on preload top-level `await` — test files evaluate their
top-level code as soon as the preload suspends.

In practice this means:

1. `loadConfigForTest()` — must run first (sync)
2. `registerApplicationServices()` — must run before any `await` (sync)
3. Database migrations — can run after, they only need to complete before the first
   test *executes*, not before test module *evaluation*

A preload smoke test lives at `tests/unit/services/preload-smoke.test.ts` and fails
fast if services are not registered at module-load time.

#### Test-specific provider/tool registration

Unit tests that call `clearRegistry()` (e.g., `tool-registry.test.ts`, `list-providers.test.ts`)
MUST snapshot the registry in `beforeEach` and restore via `registerProviders()` /
`registerTools()` in `afterEach`. After a test file completes, the global registries
must be fully populated so that subsequent files see the expected runtime services.

When adding a new provider or tool, update `tests/support/registration-expectations.ts`
so the expectation lists stay co-located with the registration points.
