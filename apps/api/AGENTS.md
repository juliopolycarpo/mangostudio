# API Workspace Guidance

Read `../../AGENTS.md` first. This file only adds API-local entrypoints, invariants, and tests.

## Start Here

- App and prefix: `src/app.ts`
- Auth: `src/auth.ts`, `src/routes/auth.ts`, `src/plugins/auth-middleware.ts`
- Domain modules (most routes): `src/modules/<module>/http/`
- Standalone routes: `src/routes/`
- Config and runtime: `src/lib/config.ts`, `src/index.ts`
- Persistence: `src/db/database.ts`, `src/db/types.ts`, `src/db/migrations/`
- Providers, secrets, and tools: `src/services/providers/`, `src/services/secret-store/`, `src/services/tools/`

For per-task file maps, use `docs/reference/agent-playbooks.md`.

## API Rules

- Route plugins define their own `.group('/path', ...)` paths without the `/api` prefix.
- Keep request and response schemas explicit, and reuse shared contracts for public shapes.
- Prefer Kysely builder in application code. Use `kysely/sql` only when a migration or SQLite edge requires it.
- Reuse config, secret-store, and provider abstractions before adding new env parsing or credential logic.
- Keep auth, connector, and provider errors explicit and logged with context.

## Tests

- Unit: `bun run --filter @mangostudio/api test:unit`
- Integration: `bun run --filter @mangostudio/api test:integration`
- **Run API tests from the workspace, not the repo root.** `bunfig.toml` (which
  declares the preload) is resolved relative to the working directory, so
  `bun test apps/api/...` from the root silently skips the bootstrap. Use the
  `--filter` commands above or `cd apps/api && bun test`. If you get them wrong,
  the harness throws an actionable error instead of touching real data.
- Integration tests must use `apps/api/tests/support/harness/create-api-test-app.ts`.
- Integration test URLs use the plugin group path directly, without `/api`.
- Validate public response shapes with `Value.Check(Schema, payload)` when the contract matters.
- Reuse `tests/support/factories` (`insertTestUser`, `insertTestChat`) instead of
  hand-seeding `user`/`chats` rows.

### Test environment bootstrap

`tests/support/setup/test-environment.ts` owns the whole Bun-test bootstrap and is
the single source of truth. The bunfig preload and the harness both go through it:

1. Installs an isolated config (`:memory:` DB + a managed temp config file, never
   the real `~/.mango`).
2. Registers providers and tools.
3. Migrates the in-memory DB.
4. Resets the managed config file between every test (global `beforeEach`/`afterEach`).

**Bun preload await gotcha:** Bun does NOT block test-module loading on the
preload's top-level `await` — test files evaluate as soon as the preload suspends.
`setupTestEnvironment()` therefore does config + service registration synchronously,
before its first `await` (migrations). Keep that ordering if you change it.

A preload smoke test (`tests/unit/services/preload-smoke.test.ts`) fails fast if
services are not registered at module-load time.

#### Config isolation

Tests must never read or write the developer's real `~/.mango`. Two layers enforce it:

- `loadConfig()` falls back to an in-memory sandbox under `NODE_ENV=test` when no
  config was installed (e.g. tests started from the repo root).
- `loadConfigForTest()` defaults to `:memory:` and the managed config path. The
  managed config file is wiped between tests, so a config-file connector written by
  one test can never leak into another's reads — provider secret services resolve
  the config path lazily, so any stale path would otherwise be picked up.

Spawned-server tests (`start-server.integration.test.ts`) must run the child under
`NODE_ENV=production` so it exercises real config resolution, not the test sandbox.

#### Test-specific provider/tool registration

Unit tests that call `clearRegistry()` (e.g., `tool-registry.test.ts`, `list-providers.test.ts`)
MUST snapshot the registry in `beforeEach` and restore via `registerProviders()` /
`registerTools()` in `afterEach`. After a test file completes, the global registries
must be fully populated so that subsequent files see the expected runtime services.

When adding a new provider or tool, update `tests/support/registration-expectations.ts`
so the expectation lists stay co-located with the registration points.
