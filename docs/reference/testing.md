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
        setup/     # test-environment.ts (bootstrap) + preload.ts
        harness/   # create-api-test-app.ts
        factories/ # insertTestUser, insertTestChat
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

### Interactive MCP coverage matrix

Keep the combinatorial protocol matrix below the browser layer. The API suites use real MCP SDK transports and the public SSE/HTTP contracts; frontend integration owns mounted and reloaded React state; Playwright is reserved for behavior that depends on an actual browser.

| Behavior                                                                                              | Owning layer              | Coverage                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| Text success, tool error, result cap, disabled server, Skill coexistence                              | API turn integration      | `modules/generation/mcp-turn.integration.test.ts`                                                   |
| Image, audio, text resource, binary resource, unsupported link, malformed content, durable provenance | API turn integration      | `modules/generation/mcp-turn.integration.test.ts`                                                   |
| Elicitation accept, decline, cancel, timeout, user abort, stale response, pending/terminal reload     | API route E2E             | `routes/respond-stream-mcp-interactive.integration.test.ts`                                         |
| Ordered `StreamChunkSchema` events and tool lifecycle snapshots                                       | API route E2E             | `routes/respond-stream-mcp-interactive.integration.test.ts`                                         |
| Same-server FIFO/correlation, disconnect, interrupted recovery handoff                                | API route E2E             | `routes/respond-stream-mcp-interactive.integration.test.ts`                                         |
| SDK wrapper, HTTP transport, stdio spawn/exit, session reconnect (through the Local runtime)          | API transport integration | `services/mcp/*-transport.integration.test.ts`, `services/mcp/wrapper-contract.integration.test.ts` |
| Mounted terminal elicitation, persisted MCP media, question resume                                    | Frontend integration      | `components/interactive-chat-flows.integration.test.tsx`                                            |
| Streamed todo cache update and persisted reload on chat switch                                        | Frontend integration      | `components/interactive-chat-flows.integration.test.tsx`                                            |
| Browser-only navigation, focus, download, or native rendering behavior                                | Browser smoke             | Add a focused Playwright case only when jsdom and API E2E cannot prove the behavior                 |

Interactive fixtures must use local SDK servers, explicit synchronization barriers, ephemeral ports, bounded diagnostics, and teardown assertions. They must not contact public MCP services, use production credentials, or depend on arbitrary sleeps for tool ordering.

## Workspace Runners

| Workspace       | Runner                | Environment                                     |
| --------------- | --------------------- | ----------------------------------------------- |
| `apps/api`      | `bun test`            | Bun native                                      |
| `apps/frontend` | `bun:test` + `vitest` | Bun native for pure logic, jsdom for React/Vite |
| `apps/shared`   | `bun:test`            | Bun native                                      |

## Root Scripts

```bash
bun run check               # format + lint + typecheck + code health
bun run code-health         # standalone Knip unused code/dependency report
bun run test                # unit + integration (e2e is opt-in)
bun run test --unit         # API, shared, and frontend unit suites
bun run test --integration  # API and frontend integration suites
bun run test:e2e:setup     # install Playwright Chromium + OS dependencies
bun run test --e2e          # Playwright Chromium auth smoke suite (opt-in)
bun run test --coverage     # coverage collection across applicable workspaces
bun run test --all          # all lanes including e2e
bun run verify              # full local CI gate: check → test --coverage → build --all
```

### Lane Taxonomy

| Lane        | Task name          | Workspaces            | Runner              | Turbo cached |
| ----------- | ------------------ | --------------------- | ------------------- | ------------ |
| unit        | `test:unit`        | api, frontend, shared | bun test / vitest   | yes          |
| integration | `test:integration` | api, frontend         | bun test / vitest   | no           |
| coverage    | `test:coverage`    | api, frontend, shared | bun test / vitest   | no           |
| e2e         | —                  | root (browser-smoke)  | Playwright Chromium | —            |
| scripts     | `//#test:scripts`  | root                  | bun test            | yes          |

Turbo skips packages that do not define a given task, so passing all workspace
filters is safe — no per-workspace metadata is needed to gate lane participation.

### Timeouts

Every lane sets a **15s floor** — `--timeout 15000` on the `bun test` lanes,
`testTimeout` / `hookTimeout` in `apps/frontend/vitest.config.ts`. Both runners
otherwise default to 5s, and a loaded CI runner is 4–14x slower than a dev
machine on subprocess-heavy tests, so the default leaves tests that pass in
milliseconds locally one bad runner away from failing on wall clock alone.

A per-test or per-hook timeout still wins in **both** directions: a test
declaring `20_000` keeps it, and one deliberately declaring a short budget stays
held to it. Declare an explicit timeout only where the number is part of what the
test asserts; otherwise take the floor.

> **Do not set this in `bunfig.toml`.** Bun has no `[test] timeout` key and
> ignores one **silently** rather than erroring — a 6s test still fails under
> `timeout = 20000`. `BUN_TEST_TIMEOUT` is ignored too. The `--timeout` CLI flag
> is the only mechanism that works (verified on Bun 1.3.14).

Raising the floor is not a substitute for fixing a slow test. Prefer removing the
cost — replay migrations against `:memory:` rather than a temp-dir SQLite file,
and reach for a real filesystem only when the test is about the filesystem.

### Parallelism

`test:unit` and `test:coverage` in `apps/api` pass `--parallel=1`. Read that as
"one worker, isolated" rather than "no parallelism": Bun's `--parallel=N` runs
files in N worker processes and **implies `--isolate`**, which gives each file a
fresh global object. Isolation is the load-bearing half. Bun's default — no
`--parallel` at all — runs every file in one process off a single module graph,
where the in-memory database from `setupTestEnvironment()` and any `mock.module`
registration outlive the file that made them.

Measured on `apps/api/tests/unit` (3421 tests, 301 files):

| Invocation                          | Result                                    |
| ----------------------------------- | ----------------------------------------- |
| `--parallel=1` (what the lane runs) | 3421 pass                                 |
| `--isolate` alone                   | 3421 pass — isolation alone is sufficient |
| neither                             | 7 fail, each at exactly 5000ms            |

The seven are turn-recovery and checkpoint tests, and they hit the timeout rather
than failing an assertion, so dropping the flag buys a suite whose failures read
as unrelated flakes.

`test:integration` deliberately does **not** take the flag. The lane passes with
`--isolate` (779 pass), but it costs 268s against 75s without — 3.5x, on a CI job
already using 7 of its 10 minutes. Isolation is the better default and the wrong
trade here; prefer substituting through production's own seams over `mock.module`
in that lane, so nothing needs a fresh global to stay correct.

#### Reproducing a cross-worker race

Raising the worker count is the only way these failures appear, and two things
decide whether you find one or watch eight clean runs go by:

- **Match CI's core count.** CI runners are 4-core; a 28-core dev machine
  schedules a different race population entirely. Pin the run —
  `taskset -c 0-3 bun test --parallel=4 tests/integration` reproduced on its
  first attempt where unpinned loops on the same machine had gone clean eight
  times in a row.
- **Capture whole logs.** A file that aborts under worker parallelism reports
  through its worker rather than the reporter, so grepping the live output for
  `(fail)` misses it. Redirect to a file per run and read the failures after.

Run the whole lane, never one file: by construction these failures land in files
other than the one at fault, and the signature is a handful of failures plus a
block of tests that never ran.

#### Never bind a well-known port in a test

A fixed port is one machine-wide resource, so two files that want it cannot both
run. Ask for port 0 and read the bound port back — `createManagedProcessFixture`
and `startOAuthLoopbackServer` both report theirs, and the ChatGPT sign-in flow
builds its redirect URI from the bound port rather than from the registered
constant so tests can take an OS-assigned one
(`setChatGptLoopbackPortForTest`). Before that, `apps/api/tests/integration` at
four workers failed 5 runs in 24 with a spurious 503 from whichever file lost
the race for `127.0.0.1:1455`; after, 22 runs in 22 were clean locally and 12 of
12 on a CI runner. A test that needs a *busy* port should bind one itself and
point the code under test at it.

The same rule covers paths: `mkdtemp` rather than a static name under
`tmpdir()`, and the managed test config directory is scoped by pid and
`BUN_TEST_WORKER_ID` and removed in `afterAll` (`process.on('exit')` does not
run under the Bun test runner).

#### Known upstream blocker on the unit lane

`tests/unit` aborts whole files intermittently under worker parallelism, losing
every remaining case in the file it hits. It is not a property of one machine —
it reproduces on GitHub's runners:

| Host                                  | Invocation                  | Runs affected |
| ------------------------------------- | --------------------------- | ------------- |
| `ubuntu-latest`, 4-core, Azure kernel | `--parallel=4`              | 2 of 36       |
| WSL2, pinned to 4 cores               | `--parallel=4`              | 4 of 10       |
| WSL2, pinned to 4 cores               | `--parallel=8`, to a file   | 4 of 12       |
| WSL2, pinned to 4 cores               | `--parallel=8`, into a pipe | 2 of 8        |

A runner run takes ~58s at four workers against 232–248s at one, so the prize is
real and this is what stands in front of it.

The error is always

```
error: EEXIST: file already exists, epoll_ctl
      at new WriteStream (internal:fs/streams:244:58)
```

— Bun building a `process.stdout`/`process.stderr` `WriteStream` for a fresh
isolate on a descriptor the process-wide epoll set still holds from the previous
one. The victim is whichever file is loading at the time, so it is never a defect
in the test that reports it, and it is not fixable from this repository.

Do not read the stack frames below `new WriteStream` as the cause. They usually
point at `google-logging-utils` inside `google-auth-library`'s module init
(reached from `@google/genai`), because that package copies the `process` module
namespace and so materializes both streams eagerly. Loading `@google/genai`
lazily removes those frames and the aborts continue — measured, not assumed. It
is the messenger.

Redirecting the run to a file makes it likelier but is not the cause; it happens
through a pipe too, which is what CI gives it.

So the unit lane cannot take worker parallelism yet. The integration lane can:
12 of 12 clean at four workers on a runner, 50.6s against 71–75s unflagged.

### Code Health

`bun run check` includes a repository-wide Knip scan. Change-scoped checks run it
when staged or changed files can affect dependencies, package exports, runtime or
test entrypoints, scripts, hooks, workflows, or workspace source. Run
`bun run code-health` directly while classifying a report.

Files loaded by runtime discovery, process spawning, test configuration, or build
aliases belong in the narrowest `entry` list in `knip.json`. Do not hide them with
file ignores. A dependency may be ignored only when repository execution evidence
shows it is loaded outside a JavaScript or TypeScript import:

| Workspace | Dependency                                               | Execution evidence                                                      |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| root      | `@dprint/markdown`, `@dprint/toml`, `@dprint/dockerfile` | `dprint.json` loads each package's WASM plugin from `node_modules`      |
| root      | `jscpd`                                                  | `scripts/qa-gate/collect/duplication.ts` spawns the installed CLI       |
| frontend  | `tailwindcss`                                            | `apps/frontend/src/index.css` loads it through the CSS `@import` syntax |

## Browser Smoke

Playwright Chromium suite under `tests/browser-smoke/`. Covers the full auth flow against a live dev stack (API on `:3001`, frontend on `:5173`).

```bash
bun run test:e2e:setup
bun run test --e2e
```

Run `bun run test:e2e:setup` once on a new machine or whenever Playwright reports a missing Chromium binary. It wraps `bunx playwright install --with-deps chromium`, so it installs only the browser used by this suite and avoids `npx` commands.

The CI browser-smoke job runs on `ubuntu-24.04` because Playwright 1.60 cannot install Chromium dependencies on Ubuntu 26.04 yet. If you are on Ubuntu 26.04 locally, use an Ubuntu 24.04/22.04 container or VM for the e2e lane until upstream support lands.

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

## Binary Smoke

`scripts/test-build.ts` builds the standalone binary for a target platform, validates
packaging layout, and boots the binary on matching CI runners to exercise core HTTP routes
plus the Cursor deprecation refusal and ChatGPT connector validation.

```bash
PLATFORM=linux-x64 bun run scripts/test-build.ts
```

On Windows hosts, use `PLATFORM=windows-x64`. The CI `Smoke — Binary` workflow runs this
script across all six native platform runners.

The runtime leg signs up a throwaway user, posts a Cursor connector with a fake API key, and
asserts the binary refuses it with `410` — Cursor is a deprecated provider, and the refusal
must hold in the shipped executable, not only where a picker hid the option. The response and
the server's stderr are still scanned for module-resolution failures such as
`Cannot find module` or `./642.js`, which is where a broken compiled binary shows itself. It
also completes a ChatGPT OAuth loopback sign-in against the fake ChatGPT auth/backend server,
then verifies the connector and model catalog. The smoke stays hermetic by pointing
`MANGO_CHATGPT_AUTH_BASE_URL` / `MANGO_CHATGPT_BASE_URL` at the fake ChatGPT server. ChatGPT
smoke tokens use `MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR` under the temporary smoke home
so the binary never writes fake tokens to the user's OS secret store. No real Cursor or
ChatGPT API calls are made.

The ChatGPT smoke needs callback port `1455`. When that port is already bound, the script
prints a skip message for the ChatGPT connector leg while keeping the rest of the binary
smoke active.

| Lane           | Runner          | Environment                       |
| -------------- | --------------- | --------------------------------- |
| `smoke-binary` | `test-build.ts` | compiled binary on native OS/arch |

## Workspace Scripts

### API

```bash
bun run --filter @mangostudio/api test:unit
bun run --filter @mangostudio/api test:integration
```

> **Run API tests from the workspace.** `apps/api/bunfig.toml` declares the test
> preload, and Bun resolves `bunfig.toml` relative to the current directory. Running
> `bun test apps/api/...` from the repo root silently skips the preload — so always use
> `bun run --filter @mangostudio/api test:unit` / `test:integration`, or
> `cd apps/api && bun test`. When the preload is skipped, the config layer falls back to
> an isolated in-memory sandbox (never the real `~/.mango`) and the harness throws an
> actionable error, so a wrong-directory run fails loudly instead of corrupting data.

### Environment-gated suites

Some API integration suites need something the machine may not have and skip themselves
rather than fail. Git and sshd suites probe for their tool; the container transport suite
needs more than a tool, so it is told what to use:

```bash
cd apps/api
MANGO_CONTAINER_E2E_IMAGE=mango-container-smoke:test \
MANGO_CONTAINER_E2E_RUNTIME=/abs/path/to/mangostudio-runtime \
bun test tests/integration/services/connect-container-runtime.integration.test.ts
```

A compiled Linux runtime binary matching the image's libc is the part a checkout does not
have. Build one with `bun build apps/runtime/src/cli.ts --compile --target=bun-linux-x64`
(or `bun-linux-x64-musl`), and use an image that satisfies the three requirements in
[hub-runtime.md](../architecture/hub-runtime.md#what-an-image-has-to-provide) — for musl that
means `alpine:3` plus `apk add --no-cache bash libstdc++`. `MANGO_CONTAINER_E2E_ENGINE=podman`
runs the same suite against podman.

CI does not compile a second copy: the `Smoke — Container` job consumes the Linux runtime
binaries the distribution lane already built, so the suite runs against release bytes.

API support lives in `apps/api/tests/support/`:

- `setup/test-environment.ts` — single source of truth for the test bootstrap (config,
  registration, migrations, and per-test config-file reset); used by the preload and harness
- `setup/preload.ts` — thin bunfig preload that delegates to `setupTestEnvironment()`
- `harness/create-api-test-app.ts` — wraps route plugins in a minimal Elysia app for `app.handle()` testing
- `factories/` — DB row factories (`insertTestUser`, `insertTestChat`)
- `mocks/` — fake collaborators (secret store, etc.)

#### Test isolation

The bootstrap points the config singleton at an in-memory database and a managed temp
config file, never the developer's real `~/.mango`. The managed config file is wiped
between every test, so a config-file connector written by one test cannot leak into
another test's reads. Tests needing custom config call `loadConfigForTest({ ... })` in
their own `beforeEach`; it defaults to `:memory:` and the managed path.

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
import Type from 'typebox';
import Value from 'typebox/value';
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

Coverage reports are written under `.mango/artifacts/coverage/`. Frontend Vitest writes the
React/Vite report to `.mango/artifacts/coverage/frontend/vitest/`, and frontend `bun:test`
writes pure-logic LCOV under `.mango/artifacts/coverage/frontend/bun/`:

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

## Unhandled Errors With Green Test Counts

A frontend Vitest run can print every file and every test as passed, then an
`Errors N errors` line, and still exit 1. That is not a flake. Do not re-run it.
CI already failed correctly. The green counts are why it looks like noise.

```
Test Files  144 passed (144)
     Tests  1150 passed (1150)
    Errors  2 errors
```

The mechanism is always the same. Something schedules a timer that outlives the
component that scheduled it. Vitest disposes that file's jsdom environment first.
The callback then runs against a global that is gone: `ReferenceError: window is
not defined`, attributed to whichever file happened to be running. It only
reproduces when the suite is loaded enough for the timer to land in that gap, so
it does not show up in a local single-file run, and re-running the job in CI is
a coin flip.

### Where to look

The stack in the job log names the leaking library. The "originated in" file is
where the run was when the timer fired, not where the timer was scheduled.
Treating that path as the owner is half of why this class is expensive.

### How to find the owner

Log inside the suspect hook or module and run the whole suite. The file that
reports the error is usually not the one that scheduled the timer.

### The rule

A component that schedules a timer clears it on unmount. A test never mounts a
third-party client whose teardown is deferred.

### Known instances

- `4d936696`. `ToastProvider` scheduled a 4s auto-dismiss `setTimeout` per toast
  and never cleared it. The originated-in file was
  `tests/unit/components/git-panel.test.tsx`.
- `b96e319a`. `useRealtimeInvalidation` reads the Better Auth session, so every
  component that syncs anything subscribed the session atom. nanostores tears an
  atom down 1s after its last listener leaves, and that disposer removes a
  `window` event listener. 18 test files mounted the real client. The
  originated-in file was `tests/unit/features/library/backup-list.test.tsx`.

The QA report and the Test job step summary lead with these error headlines when
the suite failed, and link here.

## CI Artifact Retention

CI artifacts fall into four retention classes; keep new uploads aligned with them:

| Class               | Examples                                               | Policy                                                 |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Job-to-job handoff  | `qa-test-metrics` fragment (test → qa-metrics)         | 1 day — consumed within the same run                   |
| Failure diagnostics | raw coverage output, Playwright traces and HTML report | 7–14 days, uploaded only `if: failure()`               |
| Release assets      | staged binaries and packages in the release pipeline   | 30 days                                                |
| Main-push baselines | `qa-metrics` envelopes from green `main` CI runs       | 90 days — exact-SHA baselines for future PR QA reports |

Green runs summarize their outcome in the step summary (`$GITHUB_STEP_SUMMARY`)
instead of uploading success-only artifacts. The browser-smoke workflow keeps a
`workflow_dispatch` input (`always_upload_report`) to upload the HTML report for
a passing run when needed.

## CI Cache Policy

All dependency and intermediate-state caches are owned by composites under
`.github/actions/`; workflows must not call `actions/cache` directly. The shared
`cache-scoped` composite owns the write-scope, trusted-`main` restore keys, and
step-summary diagnostics for every family. Callers supply `family`, `path`, and
a `validity` string (toolchain versions plus content hashes). `setup-mango`
wraps the Bun install family; every other family is invoked from the workflow
that produces or consumes it.

| Family                | Producer / consumer           | Path                               | Invalidators                                    | Restore behavior                  |
| --------------------- | ----------------------------- | ---------------------------------- | ----------------------------------------------- | --------------------------------- |
| Bun install           | every job using `setup-mango` | `~/.bun/install/cache`             | OS, arch, Bun version, lockfile                 | loose trusted-`main` prefix       |
| Turbo task output     | check, test, build            | `.turbo/cache`                     | OS, arch, Bun/Turbo versions, lane, task config | lane-scoped trusted-`main` prefix |
| Vite optimizer        | test and build                | `apps/frontend/node_modules/.vite` | lockfile and frontend/Vite/Vitest/TS config     | lane-scoped trusted-`main` prefix |
| TypeScript build info | check                         | `.mango/artifacts/tsbuildinfo/`    | TypeScript version, tsconfig graph, TS sources  | version-scoped trusted-`main`     |
| Workflow lint tools   | check                         | `.mango/artifacts/tools/`          | pinned tool manifest                            | exact trusted restore only        |
| Playwright browser    | browser smoke                 | `~/.cache/ms-playwright`           | OS, arch, Playwright version                    | exact trusted restore only        |

`mode` selects `restore-save` (default), `restore`, or `save`. Exact-restore
families (`lint-tools`, `playwright`) set `exact-restore: true` so a loose
prefix hit cannot mark `cache-restored` and skip a required install —
Playwright browsers and checksum-pinned lint tools are unusable across
versions. Only `mode: restore` uses `actions/cache/restore`, which is the sole
mode that reports a trusted-`main` match; `restore-save` sees a primary-key hit
only. `cache-restored` is therefore only safe to gate an install step when the
call site opts into both exact restore and `mode: restore` (today: Playwright).

The binary and Docker smoke matrix (`smoke-binary.yml`) restores no caches: it
only pins Bun and runs dependency-free release scripts. Manual `rebuild` dispatches
still use `setup-mango` because they compile inside the job. The QA metrics job
consumes the frontend dist artifact and restores no family beyond the Bun
install cache that `setup-mango` brings with it.

`CI_CACHE_EPOCH` is the repository-wide emergency invalidation lever. It is an
Actions repository variable with a documented `v1` fallback, passed explicitly
to every cache call site. Composite actions cannot read the `vars` context, so
callers must keep supplying `cache-epoch` rather than relying on a composite
default. Increment the variable (for example, to `v2`) to force a clean miss
after suspected poisoning or a broken key rollout. Removing the variable returns
to `v1`; only do that for a benign rollback because old `v1` entries may still
exist.

Main pushes write reusable `main` keys. Pull requests first restore a matching
trusted `main` key, then write only a `pr-<number>` primary key; fork permissions
may make that final save restore-only. Other trusted triggers use run-scoped
primary keys and can restore only `main` prefixes. Consequently, privileged
release jobs never restore a PR-produced cache. Cache paths contain dependencies
or rebuildable intermediate state only—distribution and QA artifacts keep their
separate upload/download policies above.

## Verification Checklist

Before merging, run:

```bash
bun run check
bun run test
# or use the full local CI gate shortcut (check → test --coverage → build --all):
bun run verify
```

`bun run verify` matches the CI pipeline minus the smoke jobs (browser and binary),
which require platform runners not available in every local environment. Run those
separately with `bun run test --e2e` and
`PLATFORM=linux-x64 bun run scripts/test-build.ts`.
