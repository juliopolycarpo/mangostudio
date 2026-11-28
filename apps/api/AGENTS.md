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
- A body schema closed with `additionalProperties: false` answers an unknown field with 422. Elysia
  rc.5 strips it by default, so `src/plugins/strict-body.ts` (mounted in `app.ts` and in
  `createApiTestApp`) restores the rejection. Do not set `normalize: false` to get it back: it is
  global and also closes open schemas, rejects query extras and turns response extras into a 500.
  `tests/integration/routes/strict-body-contract.integration.test.ts` walks every body route; a
  route with an open root schema is listed, with a reason, in `tests/support/fixtures/strict-body-routes.ts`.
- Prefer Kysely builder in application code. Use `kysely/sql` only when a migration or SQLite edge requires it.
- Reuse config, secret-store, and provider abstractions before adding new env parsing or credential logic.
- Keep auth, connector, and provider errors explicit and logged with context.

## Tests

- Unit: `bun run --filter @mangostudio/api test:unit`
- Integration: `bun run --filter @mangostudio/api test:integration`
- Run the `--filter` commands above from the repo root. They enter the API workspace,
  where `bunfig.toml` supplies the preload, and the worker runner starts each test process
  through `runWithTestHome` with a throwaway home. For one file, preserve both boundaries:
  `(cd apps/api && bun ../../scripts/with-test-home.ts bun test --timeout 15000 tests/unit/services/preload-smoke.test.ts)`.
  A bare `bun test apps/api/...` from the root also skips the preload; the harness reports
  the missing bootstrap.
- The `test:*` scripts start Bun with a throwaway `HOME` (`scripts/with-test-home.ts`), so tests
  may create and read `~/.mango` freely inside it. A bare `bun test` bypasses that, and the preload
  aborts it before any test touches your real home: use the scripts. A fixture that spawns `git` with its own `env` forwards
  `gitFixtureEnv()` from `tests/support/git-fixture-env.ts`. See `docs/reference/testing.md`.
- Fake a module with `moduleMockerFor(import.meta.dir)` from `tests/support/mocks/module-mocks.ts`,
  not a raw `mock.module(`: it restores the real module after each test, and
  `tests/unit/support/module-mock-guard.test.ts` fails on a raw call, in any spelling.
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
The preload backs this up for tools: it captures the registry after startup registration and
puts it back after every test (`tests/support/setup/tool-registry-baseline.ts`), so a missed
restore no longer hides a built-in tool from later files. Do not rely on it; keep restoring.

When adding a new provider or tool, update `tests/support/registration-expectations.ts`
so the expectation lists stay co-located with the registration points.
