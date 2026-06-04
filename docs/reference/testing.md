# Testing Strategy

This monorepo uses a workspace-first testing architecture under `apps/*/tests`. Production code stays in `src/`, and tests are grouped by intent as `unit` or `integration`.

## Directory Structure

```text
apps/
  api/
    tests/
      unit/
      integration/
      support/
        harness/   # create-api-test-app.ts
        mocks/     # fake collaborators

  frontend/
    tests/
      unit/
      integration/
      support/
        setup/     # vitest.setup.ts
        harness/   # render.tsx
        mocks/     # create-fetch-scenario.ts (jsdom hooks only)

  shared/
    tests/
      unit/
```

`support/` is reserved for helpers that remove real duplication inside a workspace. Only create subfolders that are immediately used.

## Test Taxonomy

- `unit`: isolates a single hook, component, service, route module, or utility.
- `integration`: covers a flow that crosses module boundaries inside the same workspace.
- `browser-smoke`: minimal Playwright Chromium suite covering end-to-end auth flows (signup, login, authenticated landing, logout, re-login).

## Workspace Runners

| Workspace       | Runner                | Environment                                     |
| --------------- | --------------------- | ----------------------------------------------- |
| `apps/api`      | `bun test`            | Bun native                                      |
| `apps/frontend` | `bun:test` + `vitest` | Bun native for pure logic, jsdom for React/Vite |
| `apps/shared`   | `bun:test`            | Bun native                                      |

## Root Scripts

```bash
bun run check               # format + lint + typecheck across all workspaces
bun run test                # unit + integration (e2e is opt-in)
bun run test --unit         # API, shared, and frontend unit suites
bun run test --integration  # API and frontend integration suites
bun run test --e2e          # Playwright Chromium auth smoke suite (opt-in)
bun run test --coverage     # coverage collection across applicable workspaces
bun run test --all          # all lanes including e2e
```

## Browser Smoke

Playwright Chromium suite under `tests/browser-smoke/`. Covers the full auth flow against a live dev stack (API on `:3001`, frontend on `:5173`).

```bash
bun run test --e2e
```

`playwright.config.ts` at the repo root starts both servers via `webServer` before running tests. In CI it enforces `workers: 1` and uploads traces/screenshots on failure.

Test scenarios (`tests/browser-smoke/auth-flow.spec.ts`):

1. `/login` page renders
2. `/signup` page renders
3. Sign up with a unique random email → lands in authenticated area
4. Logout → redirected to login
5. Log back in with same credentials → lands in authenticated area

| Lane            | Runner                  | Environment          |
| --------------- | ----------------------- | -------------------- |
| `browser-smoke` | `playwright` (Chromium) | real browser + stack |

## Workspace Scripts

### API

```bash
bun run --filter @mangostudio/api test:unit
bun run --filter @mangostudio/api test:integration
```

API support lives in `apps/api/tests/support/`:

- `harness/create-api-test-app.ts` — wraps route plugins in a minimal Elysia app for `app.handle()` testing
- `mocks/` — fake collaborators (secret store, etc.)

### Frontend

```bash
bun run --filter @mangostudio/frontend test:unit
bun run --filter @mangostudio/frontend test:integration
bun run --filter @mangostudio/frontend test:coverage
```

Frontend support lives in `apps/frontend/tests/support/`:

- `setup/vitest.setup.ts` — runtime bootstrap only
- `harness/render.tsx` — minimal render surface with providers
- `mocks/create-fetch-scenario.ts` — method-and-path fetch registry **for React hook tests only** (see scope below)

### Shared

```bash
bun run --filter @mangostudio/shared test:unit
```

`shared` keeps runtime test utilities in `src/test-utils/`, but tests for that workspace live in `apps/shared/tests/unit/`.

## Writing Tests

### API Integration — with Typebox schema validation

```typescript
import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { settingsRoutes } from '../../../src/routes/settings';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

// Route plugin uses .group('/settings', ...) — no /api prefix in tests
const app = createApiTestApp(settingsRoutes);

const ResponseSchema = Type.Object({
  configured: Type.Boolean(),
  status: Type.Union([Type.Literal('idle'), Type.Literal('ready'), Type.Literal('error')]),
  allModels: Type.Array(Type.Any()),
});

describe('settingsRoutes', () => {
  it('validates response shape with Typebox', async () => {
    const response = await app.handle(new Request('http://localhost/settings/models/gemini'));
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(Value.Check(ResponseSchema, payload)).toBe(true);
  });
});
```

> **Important**: route plugins use `.group('/path', ...)` without the `/api` prefix. That prefix is added in `app.ts` via `new Elysia({ prefix: '/api' })`. Test URLs must use the plugin's own group path.

### API Unit Example

```typescript
import { describe, expect, it } from 'bun:test';
import { createGeminiSecretService } from '../../../src/services/gemini-secret';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

describe('createGeminiSecretService', () => {
  it('returns environment fallback when no stored key exists', async () => {
    const service = createGeminiSecretService({
      secretStore: new InMemorySecretStore(),
      getEnvironmentKey: () => 'env-key-5678',
    });

    const status = await service.getGeminiSecretStatus();
    expect(status.source).toBe('environment');
  });
});
```

### Frontend Integration — React hook tests (use fetch mock)

`create-fetch-scenario.ts` is scoped to **React hook tests** in jsdom — hooks that call `fetch` via Eden Treaty and cannot access the Elysia app directly. Do not use it for API contract tests.

```tsx
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const fetchScenario = createFetchScenario();

fetchScenario.install().respondWithJson('GET', '/api/settings/secrets/gemini', {
  body: { configured: false, source: 'none' },
});

render(<SettingsPage {...props} />);
await screen.findByText('Not Configured');

fetchScenario.restore();
```

## Support Rules

- Do not add empty `support` subfolders for symmetry.
- Keep helpers local to a test file unless they remove duplication across multiple files.
- Prefer one explicit harness over layered abstractions.
- Keep mocks focused on real request or dependency seams.
- For API contract validation, use `Value.Check` with an inline Typebox schema — this catches breaking response shape changes immediately.

## Module Tests (API)

API domain modules place tests under the workspace-level `tests/` directory:

```
apps/api/tests/
  unit/modules/<module-name>/         # Unit tests for application services
  integration/modules/<module-name>/  # Integration tests using createApiTestApp
```

Module integration tests use `createApiTestApp` with the module's HTTP route
plugin (e.g., `createApiTestApp(chatRoutes)`). Test URLs must use the plugin's
own group path (no `/api` prefix — that is added in `app.ts`).

## Continuation / Provider Test Matrix

Refer to `docs/architecture/continuation.md` and `docs/providers/development.md` for the
architecture and development guide. The test matrix covers three layers:

### Decision engine (`continuation.test.ts`)

Pure-function tests in `apps/api/tests/unit/services/providers/continuation.test.ts`:

| Test                     | What it validates                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Envelope parse/serialise | Round-trip identity, null/undefined/malformed, schema version, mode validation, cursor requirement |
| Envelope validation      | Provider/model/system prompt/toolset mismatch detection                                            |
| `decideContinuation`     | `continue_with_cursor`, `degrade_to_replay`, `start_replay` decisions                              |
| `decideTurnPersistence`  | Durable cursor persisted, stateless-loop filtered                                                  |
| Provider switch          | OpenAI→Gemini first turn degrades, Gemini cursor on second                                         |

### Replay builders (`replay-builder.test.ts`)

Tests in `apps/api/tests/unit/services/providers/replay-builder.test.ts`:

- Each provider's replay format (OpenAI, Gemini, OpenAI-compatible)
- Text-only, tool-call-only, mixed content
- Empty history and backward-compatible plain text

### Provider-specific cursor-loss handling

Each provider stream test must cover:

- First turn with no cursor → full replay
- Cursor continuation → minimal input
- Cursor loss (no tool results) → retry with replay
- Cursor loss (with tool results) → abort with `tool_result_cursor_loss`

---

## Coverage

Frontend coverage is written to `apps/frontend/coverage/`. Vitest writes the
React/Vite coverage report, and `bun:test` writes pure-logic LCOV under
`apps/frontend/coverage/bun/`:

```bash
bun run --filter @mangostudio/frontend test:coverage
```

Current frontend coverage thresholds:

- Statements: `70`
- Branches: `60`
- Functions: `64`
- Lines: `72`

Last verified with `bun run test --coverage` on this baseline:

- Statements: `71.74%`
- Branches: `62.92%`
- Functions: `65.30%`
- Lines: `73.81%`

When raising or repairing coverage, prioritize release-critical surfaces first:

- Auth lifecycle routes and logout/session transitions
- Connector settings CRUD and provider validation errors
- Chat orchestration and streaming UI states
- Gallery loading, empty, pagination, and download flows

## Verification Checklist

Before merging, run:

```bash
bun run check
bun run test
# or use the full CI gate shortcut:
bun run verify
```
