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

| Workspace         | Runner             | Environment |
|-------------------|--------------------|-------------|
| `apps/api`        | `bun test`         | Bun native  |
| `apps/frontend`   | `vitest`           | jsdom       |
| `apps/shared`     | `vitest`           | node        |

## Root Scripts

```bash
bun run test                # unit + integration across all workspaces
bun run test:unit           # API, shared, and frontend unit suites
bun run test:integration    # API and frontend integration suites
bun run test:coverage       # frontend coverage (Vitest/v8)
bun run test:browser:smoke  # Playwright Chromium auth smoke suite
bun run verify              # lint + typecheck + tests + coverage + build
```

## Browser Smoke

Playwright Chromium suite under `tests/browser-smoke/`. Covers the full auth flow against a live dev stack (API on `:3001`, frontend on `:5173`).

```bash
bun run test:browser:smoke
```

`playwright.config.ts` at the repo root starts both servers via `webServer` before running tests. In CI it enforces `workers: 1` and uploads traces/screenshots on failure.

Test scenarios (`tests/browser-smoke/auth-flow.spec.ts`):

1. `/login` page renders
2. `/signup` page renders
3. Sign up with a unique random email → lands in authenticated area
4. Logout → redirected to login
5. Log back in with same credentials → lands in authenticated area

| Lane            | Runner                  | Environment        |
|-----------------|-------------------------|--------------------|
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
    const response = await app.handle(
      new Request('http://localhost/settings/models/gemini')
    );
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

fetchScenario
  .install()
  .respondWithJson('GET', '/api/settings/secrets/gemini', {
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

## Coverage

Frontend coverage is written to `apps/frontend/coverage/`:

```bash
bun run --filter @mangostudio/frontend test:coverage
```

## Verification Checklist

Before merging, run:

```bash
bun run --filter @mangostudio/api test:unit
bun run --filter @mangostudio/api test:integration
bun run --filter @mangostudio/frontend test:unit
bun run --filter @mangostudio/frontend test:integration
bun run --filter @mangostudio/shared test:unit
bun run lint
bun run test
bun run test:coverage
```
