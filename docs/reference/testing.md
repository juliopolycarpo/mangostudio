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
        setup/     # dom-setup.ts + bun.setup.ts (bunfig preloads)
        harness/   # render.tsx, render-with-router.tsx, timers.ts
        mocks/     # create-fetch-scenario.ts (happy-dom hook tests only)

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
| Browser-only navigation, focus, download, or native rendering behavior                                | Browser smoke             | Add a focused Playwright case only when happy-dom and API E2E cannot prove the behavior             |

Interactive fixtures must use local SDK servers, explicit synchronization barriers, ephemeral ports, bounded diagnostics, and teardown assertions. They must not contact public MCP services, use production credentials, or depend on arbitrary sleeps for tool ordering.

## Workspace Runners

| Workspace       | Runner     | Environment                                    |
| --------------- | ---------- | ---------------------------------------------- |
| `apps/api`      | `bun test` | Bun native                                     |
| `apps/frontend` | `bun test` | Bun native for pure logic, happy-dom for React |
| `apps/shared`   | `bun:test` | Bun native                                     |

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
| unit        | `test:unit`        | api, frontend, shared | bun test            | yes          |
| integration | `test:integration` | api, frontend         | bun test            | no           |
| coverage    | `test:coverage`    | api, frontend, shared | bun test            | no           |
| e2e         | —                  | root (browser-smoke)  | Playwright Chromium | —            |
| scripts     | `//#test:scripts`  | root                  | bun test            | yes          |

Turbo skips packages that do not define a given task, so passing all workspace
filters is safe — no per-workspace metadata is needed to gate lane participation.

### Timeouts

Every lane sets a **15s floor** — `--timeout 15000`, passed on the command line
because `bunfig.toml`'s `timeout` key is ignored in this workspace. `bun test`
otherwise defaults to 5s, and a loaded CI runner is 4–14x slower than a dev
machine on subprocess-heavy tests, so the default leaves tests that pass in
milliseconds locally one bad runner away from failing on wall clock alone.

A per-test or per-hook timeout still wins in **both** directions: a test
declaring `20_000` keeps it, and one deliberately declaring a short budget stays
held to it. Declare an explicit timeout only where the number is part of what the
test asserts; otherwise take the floor.

> **Do not set this in `bunfig.toml`.** Bun has no `[test] timeout` key and
> ignores one **silently** rather than erroring — a 6s test still fails under
> `timeout = 20000`. `BUN_TEST_TIMEOUT` is ignored too. The `--timeout` CLI flag
> is the only mechanism that works (re-verified on Bun `1.4.0-canary.1`: a 6s
> test still times out at 5000ms under both, and passes under `--timeout 20000`).

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

Measured on `apps/api/tests/unit` (3437 tests, 301 files), Bun
`1.4.0-canary.1`, `--timeout 15000` throughout:

| Invocation                          | Result                                            |
| ----------------------------------- | ------------------------------------------------- |
| `--parallel=1` (what the lane runs) | 3437 pass, 188.8s                                 |
| `--isolate` alone                   | 3437 pass, 186.7s — isolation alone is sufficient |
| neither                             | 172 fail, 3263 pass, 128.7s                       |

Dropping the flag costs 172 failures, not the seven this table used to record.
The seven are still there — the same turn-recovery and checkpoint tests, now
timing out at the 15s floor rather than the old 5s default — but they are 7 of
172. The other 165 fail in **under 2ms**, on assertions rather than wall clock:
`todo repository`, `requiresExternalDisclosure`, `external turn controller` and
`external session manager` account for most of them. So the mode does not merely
buy failures that read as unrelated flakes; it buys a suite that is wrong about
its own subject matter. Nor is it a race — repeated runs return the same count.

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

It is [oven-sh/bun#37968](https://github.com/oven-sh/bun/issues/37968), reproduced
and root-caused upstream — a leaked epoll registration on a reused stdio
descriptor at the isolate global swap — with a fix open at
[oven-sh/bun#38008](https://github.com/oven-sh/bun/pull/38008). Check whether that
has shipped before re-investigating any of this. Note that the issue recommends
redirecting to regular files as a workaround; that made it *worse* here, not
better, so measure before adopting it.

> **A green canary run is not evidence the bug is gone.** The abort stopped
> firing on the post-rewrite builds this repo now tracks, but the leak that
> causes it did not go away. Counting how many of an isolate's fds point at the
> same pipe as fd 2 — PR #38008's own regression test — gives `4 6 8 10 12 14 16
> 18` across eight files on `1.4.0-canary.1+32e87032b`: two leaked per file,
> still climbing. Only #38008 flattens it to a constant `4`. So the collision
> merely stopped being *observable* on this suite; whether it reappears is a
> question of fd-number timing on some future runner. Wait for that patch
> specifically, not for "a newer Bun".

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

### Sharding

`--parallel=N` is blocked; `--shard=i/N` is not, and it reaches the same prize
from the other side. Workers put concurrent isolates inside **one** Bun process,
which is the precondition for the abort above. A shard is a subset of files run
by a process that never shares itself with another shard, so that precondition
never exists. The two compose: in-job `--parallel` still applies the day
oven-sh/bun#38008 ships.

`bun run test --coverage --shard=i/N` splits every lane at once. Each Bun lane
takes the flag through `MANGOSTUDIO_BUN_TEST_ARGS`; the frontend Vitest lane
takes `MANGOSTUDIO_VITEST_ARGS` and switches to a **blob report** for the merge
step to replay. `--shard` requires `--coverage`: it is the only lane with a
merge step behind it, and a shard of any other lane would run a fraction of the
files and exit 0.

> **`--reporter=blob` does not switch the coverage thresholds off.** A sharded
> Vitest run still evaluates them, against a fraction of the sources, and so
> fails on *every* shard — measured, and the reason `vitest.config.ts` drops
> `coverage.thresholds` when `MANGOSTUDIO_TEST_SHARD` is set. The merge
> invocation is unsharded, so it is what enforces them.

CI runs eight shards plus one merge job (`.github/workflows/test.yml`). Where
the run's time actually goes, measured on run 32331139863 (four-core runner,
Turbo running the lanes concurrently):

| Lane                                          | Files | Duration |
| --------------------------------------------- | ----- | -------- |
| `apps/api` `bun test --coverage --parallel=1` | 398   | 278.3s   |
| `apps/frontend` `vitest run --coverage`       | 165   | 189.4s   |
| `apps/runtime`                                | 63    | 26.4s    |
| root `test:scripts`                           | 81    | 16.3s    |
| `apps/shared`                                 | 54    | 1.8s     |
| `apps/frontend` Bun files                     | 2     | 0.1s     |

Two long poles, not one, which is why the shard boundary is a slice of *every*
lane rather than one job per workspace: a per-workspace split leaves `apps/api`
alone at 278s.

Eight is where the curve flattens. What bites is the ~21s of fixed setup each
job pays and the merge job's fixed cost, so measured per-shard test time of 70s
→ 35s → 23s at N=4 → 8 → 12 turns into diminishing wall clock. Raising it is a
three-line change: `SHARD_COUNT`, the matrix list, and the shard job's `name`
(`env` is not one of the contexts available to `jobs.<id>.name`, so the `/8`
there cannot interpolate the value).

#### Balancing the split by time

> An earlier revision of this section concluded that **no timings file was
> needed** and that `--timings` would buy "under 1%". That was reasoned from the
> slowest single file (20.2s of 348s) as the lower bound on the critical shard.
> The reasoning was wrong: the imbalance does not come from one big file, it
> comes from five lanes each round-robining their own file list, and the sums
> landing unevenly. Re-measured from real per-file durations on Bun 1.4.0:

| Split                                 | Critical shard | Spread across shards |
| ------------------------------------- | -------------- | -------------------- |
| Round-robin (Bun's default `--shard`) | 69.6s          | 34.5s                |
| `--timings`, each lane balanced       | 58.6s          | 16.4s                |
| Perfect joint balance (not reachable) | 45.0s          | 0s                   |

Bun's `--shard=i/N` is a **round-robin over the alphabetical file list** — file
at index `k` runs on shard `k % N + 1` (verified against `apps/shared`). Given
`--timings=<file>`, it balances by measured duration instead.

The joint optimum is out of reach because each lane balances independently, and
they all put their own slowest file on the same shard index — `apps/api` (8.7s),
root (9.6s) and `apps/runtime` (6.5s) all land on shard 1, which is why the
balanced critical shard is 58.6s rather than the 45.0s mean.

**The timings file is a correctness dependency, not just a speed one.** Under
round-robin, all N shards derive the same partition independently and *cannot*
disagree. Under `--timings` the partition is a function of a shared file, so N
shards reading different bytes will not cover the file set between them — some
files run twice, others not at all, and every shard still exits 0. Three things
hold that down:

- Only the merge job writes the cache, and only after all eight shards have read
  it, so nothing changes underneath a fan-out in progress.
- `scripts/ci/merge-timings-shards.ts` fails the run if two shards claim the
  same file, which is the observable symptom of a disagreement.
- A **missing** file is tolerated by Bun and falls back to round-robin, so a cold
  cache degrades to the old behaviour instead of failing. A **malformed** file is
  a hard error — including `{}` — so nothing writes a placeholder.

The root `//#test:scripts` lane **opts out**. It is the only test task Turbo
caches, and a timings file is untracked, so it cannot enter that cache key: shard
`i` would restore a `root.xml` produced when the split put different files on
shard `i`. Balancing it is worth 0.5s within the lane and 0.6s overall (59.2s vs
58.6s critical shard), which does not pay for that hazard.

#### Merging is not concatenation

**Vitest merges exactly.** `--reporter=blob` per shard, then
`vitest --mergeReports --coverage` (`test:coverage:merge`) replays them. Four
shards merged reproduce the unsharded run's numbers to the digit —
`76.08 / 68.06 / 72.81 / 78.76` statements/branches/functions/lines — and that
merge is where the coverage thresholds apply, so a drop there is a real drop.
It costs about four seconds.

**Bun's LCOV does not.** Its per-file `LF:`/`FNF:` are *run-dependent*: a source
file a shard loaded but never exercised reports every line as coverable, while
the same file under a shard that ran its code reports the collapsed set lazy
parsing leaves behind. On `apps/shared` at `--shard=i/3`,
`src/errors/negotiation.ts` is `LF:208 LH:0` in two shards and `LF:98 LH:92` in
the third. Union the `DA:` lines and the denominator inflates — 15,303 coverable
lines against the unsharded 14,740, reporting **94.26% where the truth is
97.86%**, a coverage regression that never happened.

So `scripts/qa-gate/merge-lcov-shards.ts` takes each file's coverable-line shape
from the shard record that covered the most of it, marks a line covered if any
shard hit it, and keeps a positive-hit line that only exists on a non-shape
record (a lazily parsed region another shard exercised). Zero-hit padding from
those other records stays out so the denominator does not inflate. Same corpus:
**97.86% lines against 97.86%**.

What the merge cannot make exact is **function** coverage. Bun emits only the
`FNF:`/`FNH:` totals, never per-function `FN:`/`FNDA:` records, so the union of
hit functions across shards is not recoverable; the merge reports the best
shard's count, clamped to the total, which is a lower bound. Measured on
`apps/runtime` against its own unsharded run:

| Shards | Lines   | Functions |
| ------ | ------- | --------- |
| 2      | −0.47pp | −1.60pp   |
| 4      | −0.55pp | −2.00pp   |
| 8      | −0.54pp | −2.52pp   |

Line drift is bounded and effectively flat past two shards. Function drift grows
with N, because the more shards a file spreads across, the further the best
single shard sits from the union. Only line coverage reaches the QA verdict
(`scripts/qa-gate/render/verdict.ts`, 0.1pp epsilon), so the function number is
a table entry rather than a signal.

> **One transitional report.** The PR QA report compares a head against a
> `main` baseline. The first PRs after sharding landed compare a sharded head
> against a pre-shard baseline and show a one-time `line coverage −0.54pp`.
> Once `main` has a sharded baseline, both sides are sharded and the delta is
> real signal again. A drop after that is a drop.

#### JUnit, and the one thing it cannot carry

Every lane writes JUnit to `.mango/artifacts/junit/<lane>.xml`, and
`scripts/qa-gate/junit-results.ts` counts `<testcase>` elements out of the shard
directories. Counts come from the elements rather than the `<testsuites>`
header because the runners disagree on the header — Bun emits
`tests`/`assertions`/`failures`/`skipped`, Vitest emits `tests`/`failures`/
`errors` and puts `skipped` only on the nested `<testsuite>`, which Bun also
nests once per `describe`.

Unhandled errors are the exception, in **both** runners. Vitest's JUnit reporter
is `onTestRunEnd(testModules)` — it never receives the run's `unhandledErrors`
and writes `errors="0"` unconditionally, and its JSON reporter takes the same
argument. Bun is the same shape from the other direction: an error raised between
tests prints a `# Unhandled error between tests` block and a `N error` summary
line and exits 1, while its JUnit report reads `failures="0"` with no failing
`<testcase>` (measured on 1.4.0-canary.1). So the failure class in
[Unhandled Errors With Green Test Counts](#unhandled-errors-with-green-test-counts)
exists only in the log for either runner, and each shard extracts it with
`scripts/qa-gate/unhandled-errors.ts` before the log leaves the job. If you ever
replace that with a structured source, check the reporter first rather than
assuming the XML grew an `errors` count.

> That only works because every Vitest invocation leads with the console
> reporters `vitest.config.ts` would have chosen (`consoleReporters()` in
> `scripts/lib/test.ts`). A CLI `--reporter` **replaces** the config's
> `reporters` rather than adding to it, so `--reporter=blob` alone prints
> exactly one line (`blob report written to …`) and no summary — measured, and
> measured end to end: the same run with `--reporter=default --reporter=blob`
> feeds `unhandled-errors.ts` `{"errors":1,…}`, and without it `{"errors":0}`.
> Drop `default` and the `Errors N errors` and `This error originated in "…"`
> lines stop being emitted at all, which silently removes the only Vitest source
> `unhandled-errors.ts` has: the run still exits 1, but the QA report degrades
> to `parseMiss` and the "this is not a flake, do not re-run it" guidance in
> `scripts/qa-gate/render/test-failures.ts` (gated on `errors > 0`) can never
> fire. `github-actions` is the second casualty of the same rule — the config
> adds it when `GITHUB_ACTIONS=true` (which Turbo does pass through to the lane
> tasks, measured), and omitting it costs the run every inline failure
> annotation.
>
> `test:coverage:merge` is the one Vitest invocation that keeps `default` alone,
> and that is deliberate. Its own failure mode is the coverage threshold gate,
> and a threshold miss is not a reporter event: istanbul prints
> `ERROR: Coverage for statements (76.1%) does not meet global threshold (100%)`
> and Vitest exits 1. Measured with the annotation reporter explicitly enabled —
> 165 files and 1343 tests green, exit 1 on the threshold, **zero** `::error`
> lines. Test failures the merge replays were already annotated by the shard
> that ran them.

> Bun does not create the parent directory for `--reporter-outfile`, and it does
> **not** fail the run when it is missing: it prints `JUnitReportFailed` and
> still exits 0 (measured on 1.4.0-canary.1), so the lane's counts go silently to
> zero. That is why `scripts/test.ts` creates `.mango/artifacts/junit/` before
> any lane starts — and clears it, so a lane that did not run this time cannot
> contribute last run's counts. The QA collector also treats a configured lane
> with no JUnit file across the shard set as `parseMiss`, so a missing report
> cannot become a green suite of zero tests. Bun's `file` attribute is
> workspace-relative; failed-file counts are namespaced by lane so
> `apps/shared` and `apps/runtime` files with the same relative path stay
> distinct. Invoking a workspace `test:coverage` script directly on a fresh
> checkout skips the directory step; create it first if you care about the
> report.

### Randomized order

`randomized-order-nightly.yml` runs `apps/api`, `apps/shared` and
`apps/runtime` under `--randomize --seed=<run number>` every night. It exists
for the one class the merge gate cannot see: a test that passes only because of
what the file before it left behind, which is a live hazard here while
`bun test` shares one module graph across a lane's files.

`--randomize` shuffles **file order** as well as the tests inside each file —
verified, not assumed: three probe files run as `c, b, a` under seed 3 where
seeds 1 and 2 keep `a, b, c`. File order is the half that matters for leaked
`mock.module` registrations.

It is deliberately not merge-gating. A suite that fails weekly on a different
seed is a bug report; making it block merges teaches everyone to re-run CI, and
that habit outlasts the fix. A failure logs its seed and uploads the run log,
because the order **is** the finding. Reproduce with
`(cd apps/<workspace> && bun test --timeout 15000 --parallel=1 --randomize --seed=<n>)`,
and read what ran before the failing file rather than the failing file itself.

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

Playwright Chromium suite under `tests/browser-smoke/`. Covers the full auth flow against a live dev stack on `:3001` — one server serving both the API and the frontend.

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

- `setup/dom-setup.ts` and `setup/bun.setup.ts` — runtime bootstrap only, loaded
  as `bunfig.toml` `[test] preload` entries in that order
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

`create-fetch-scenario.ts` is scoped to **React hook tests** in happy-dom — hooks that call `fetch` via Eden Treaty and cannot access the Elysia app directly. Do not use it for API contract tests.

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

Coverage reports are written under `.mango/artifacts/coverage/`. The whole frontend suite
now runs on `bun test`, which writes LCOV under `.mango/artifacts/coverage/frontend/bun/`;
`.mango/artifacts/coverage/frontend/vitest/` is produced by a lane that matches no files:

```bash
bun run --filter @mangostudio/frontend test:coverage
```

**The frontend declares no coverage thresholds right now.** The previous
70/60/64/72 were istanbul figures measured over the Vitest suite, and that suite
has moved runners — the numbers describe a file set that no longer exists, and
`bun test`'s own LCOV is not comparable to istanbul's. They are re-derived
against the Bun lane rather than carried over.

When raising or repairing coverage, prioritize release-critical surfaces first:

- Auth lifecycle routes and logout/session transitions
- Connector settings CRUD and provider validation errors
- Chat orchestration and streaming UI states
- Gallery loading, empty, pagination, and download flows

## Unhandled Errors With Green Test Counts

A frontend run can report every file and every test as passed and still print an
error block — `Errors N errors` under Vitest, `# Unhandled error between tests`
under `bun test` — and exit 1. That is not a flake. Do not re-run it. CI already
failed correctly. The green counts are why it looks like noise.

```
Test Files  144 passed (144)
     Tests  1150 passed (1150)
    Errors  2 errors
```

The mechanism is always the same. Something outlives the test that started it —
a timer, a `lazy()` chunk behind a Suspense boundary, an unanswered `fetch` — and
lands after the environment it belonged to is gone or after React stopped
watching. The result is attributed to whichever file happened to be running.
It only reproduces when the suite is loaded enough for the callback to land in
that gap, so it does not show up in a local single-file run, and re-running the
job in CI is a coin flip.

Three guards exist for the three shapes this takes under `bun test` + happy-dom,
and a change that removes one will not fail any test:

- `bun.setup.ts` installs a `fetch` that rejects immediately, so an unanswered
  request cannot open a socket to `localhost:3001` and strand an
  `ECONNREFUSED` under an unrelated file.
- `support/harness/timers.ts` drains the fake-timer queue before restoring real
  ones, because React Query announces through a live `setTimeout(callback, 0)`
  and dropping one leaves its notify manager unable to deliver again.
- `support/harness/render.tsx` exports `flushAsyncRender()` for a render whose
  content arrives asynchronously; without it the Suspense resolution lands
  outside `act` and prints a warning on a passing test.

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

| Class               | Examples                                                                | Policy                                                 |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Job-to-job handoff  | `test-shard-<n>` (shard → merge), `qa-test-metrics` (test → qa-metrics) | 1 day — consumed within the same run                   |
| Failure diagnostics | `test-shard-<n>-log`, merged coverage, Playwright traces and report     | 7–14 days, uploaded only `if: failure()`               |
| Release assets      | staged binaries and packages in the release pipeline                    | 30 days                                                |
| Main-push baselines | `qa-metrics` envelopes from green `main` CI runs                        | 90 days — exact-SHA baselines for future PR QA reports |

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

| Family                | Producer / consumer           | Path                               | Invalidators                                             | Restore behavior                  |
| --------------------- | ----------------------------- | ---------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Bun install           | every job using `setup-mango` | `~/.bun/install/cache`             | OS, arch, Bun revision, lockfile                         | loose trusted-`main` prefix       |
| Turbo task output     | check, test, build            | `.turbo/cache`                     | OS, arch, Bun revision, Turbo version, lane, task config | lane-scoped trusted-`main` prefix |
| Vite optimizer        | test and build                | `apps/frontend/node_modules/.vite` | lockfile and frontend/Vite/Vitest/TS config              | lane-scoped trusted-`main` prefix |
| TypeScript build info | check                         | `.mango/artifacts/tsbuildinfo/`    | TypeScript version, tsconfig graph, TS sources           | version-scoped trusted-`main`     |
| Workflow lint tools   | check                         | `.mango/artifacts/tools/`          | pinned tool manifest                                     | exact trusted restore only        |
| Playwright browser    | browser smoke                 | `~/.cache/ms-playwright`           | OS, arch, Playwright version                             | exact trusted restore only        |

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
