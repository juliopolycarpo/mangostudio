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

`test:unit` and `test:coverage:unit` in `apps/api` pass `--parallel=1`. Read
that as "one worker, isolated" rather than "no parallelism": Bun's
`--parallel=N` runs files in N worker processes and **implies `--isolate`**,
which gives each file a fresh global object. Isolation is the load-bearing
half. Bun's default — no `--parallel` at all — runs every file in one process
off a single module graph, where the in-memory database from
`setupTestEnvironment()` and any `mock.module` registration outlive the file
that made them.

The api coverage lane is **two invocations, with opposite settings**:
`test:coverage:unit` keeps `--parallel=1`, `test:coverage:integration` takes no
flag at all, and `test:coverage` delegates to
`scripts/ci/run-workspace-coverage.ts`, which runs both lanes and merges their
LCOV slices into the one staged `coverage/api/lcov.info`. The orchestrator is
there instead of an `&&` chain because a chain lets one failing unit test skip
the integration lane *and* the merge: the red shard then uploads no integration
JUnit and no api LCOV, and a failure shared across the shards kills the merge
job on a missing input rather than reporting the test failures. Every lane runs
whatever the earlier ones did, the merge runs over whatever slices exist (none
is not an error), and the exit code is the first failing lane's. The split
itself exists because the unit
suite cannot live without isolation (the 172-failure table below) while the
integration suite cannot safely live *inside* it — Bun's isolate machinery is
what intermittently hangs the whole invocation in CI (see [The isolate runner can hang](#the-isolate-runner-can-hang)), and the spawn-heavy integration
files are where the wedge has been observed.

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

#### The isolate runner can hang

The abort above is the loud failure. The quiet one: a `bun test` in isolate
mode — **including `--parallel=1`** — sometimes never exits. Every lane that
finished shows its summary, the log freezes, and the job burns its whole
`timeout-minutes` before the runner kills orphaned `bun`/`turbo` processes. A
milder form of the same wedge shows up as `spawnSync git --version` stalling
15s+ inside integration files (visible via `MANGOSTUDIO_SPAWN_DIAGNOSTICS`),
timing out tests with `killed 1 dangling process`.

Observed on stock Bun 1.4.0 across at least seven CI runs (different PRs and
`main`) in the week after the 1.4.0 pin, always in the api coverage lane — the
only isolate-mode lane in the shard matrix. Upstream this is
[oven-sh/bun#39709](https://github.com/oven-sh/bun/issues/39709) (isolate
runner never exits after its per-file work; dropping `--isolate` removes it)
and [oven-sh/bun#39584](https://github.com/oven-sh/bun/issues/39584). Bun
1.4.0 shipped without oven-sh/bun#38008; in the 234-run soak recorded above,
the only build with zero hangs across 85 runs was the #38008 build, so that
patch is the unblock for this too.

Two mitigations are in place until it ships:

- The api **integration** suite runs outside isolate mode (see
  [Parallelism](#parallelism)).
- Every CI test invocation runs under `scripts/ci/run-tests-watchdog.ts`,
  which kills the invocation's process group after a per-attempt bound and
  retries once, restoring the timings baseline first so the retry computes the
  same shard partition as the other seven jobs.

**Why "re-run failed jobs" used to re-hang while "re-run all jobs" passed:**
the hang follows specific files, and the file-to-shard partition is a function
of the resolved timings baseline. Rerunning only failed jobs reuses the
successful `resolve-timings` job's output — the identical partition, so the
trigger files land on the same shard again. Rerunning all jobs re-resolves the
baseline, which usually rotated in the meantime, moving or splitting the
trigger files.

### Sharding

`--parallel=N` is blocked; `--shard=i/N` is not, and it reaches the same prize
from the other side. Workers put concurrent isolates inside **one** Bun process,
which is the precondition for the abort above. A shard is a subset of files run
by a process that never shares itself with another shard, so that precondition
never exists. The two compose: in-job `--parallel` still applies the day
oven-sh/bun#38008 ships.

What sharding does *not* sidestep is [the isolate runner hang](#the-isolate-runner-can-hang): that needs no concurrency, only isolate
mode, so it rode along into the shard jobs until the api integration suite
left isolate mode. More shards is not a defense either — it only reshuffles
which shard the trigger files land on.

`bun run test --coverage --shard=i/N` splits every **sharded** lane at once;
each takes the flag through `MANGOSTUDIO_BUN_TEST_ARGS`. `--shard` requires
`--coverage`: it is the only lane with a merge step behind it, and a shard of
any other lane would run a fraction of the files and exit 0.

**The frontend lane does not shard.** Bun's LCOV cannot be reassembled from
slices (see [Merging is not concatenation](#merging-is-not-concatenation)), so
its coverage has to come from one invocation. CI runs it whole in its own job
via `bun run test --coverage --only=frontend`, parallelised in-process instead:
`--parallel=4 --isolate`, adopted after a 12-run soak of the full 167-file
suite pinned to four cores came back 12/12 clean — 1397 pass / 0 fail every
run, zero `epoll_ctl`, zero hangs, ~34s per run against a ~102s serial
baseline. The lane registry (`scripts/lib/test-lanes.ts`) carries the
`sharded` flag, and `test-lanes.unit.test.ts` pins that the frontend's script
cannot even receive `$MANGOSTUDIO_BUN_TEST_ARGS`.

> The soak matters because oven-sh/bun#37968 (the fd-leak/`epoll_ctl` abort) is
> still open upstream; a green run means the collision is not manifesting at
> this scale, not that the defect is gone. If CI later reproduces it, drop to
> `--parallel=2` first — parallelism *divides* the stale-registration
> accumulation across workers, so serial `--isolate` concentrates rather than
> avoids it.

CI runs eight shards, the frontend job, and one merge job
(`.github/workflows/test.yml`). Where the sharded run's time went when the
split was designed, measured on run 32331139863 (four-core runner, Turbo
running the lanes concurrently, the frontend then still on Vitest at 189.4s):

| Lane                                          | Files | Duration |
| --------------------------------------------- | ----- | -------- |
| `apps/api` `bun test --coverage --parallel=1` | 398   | 278.3s   |
| `apps/runtime`                                | 63    | 26.4s    |
| root `test:scripts`                           | 81    | 16.3s    |
| `apps/shared`                                 | 54    | 1.8s     |

The shard boundary is a slice of *every* sharded lane rather than one job per
workspace: a per-workspace split leaves `apps/api` alone at 278s.

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

#### Why the unisolated lane opts out too

`api-integration` also opts out, for the opposite reason: everything above
assumes each file starts from a fresh global, and that lane is the one where it
does not.

It is the only lane that is both **sharded and unisolated**. Its files share one
module graph, so what a shard runs a file *beside* decides what that file
inherits — the in-memory database from `setupTestEnvironment()`, any
`mock.module` registration, the memoized `getAuth()`. A timings-balanced
partition is a function of a file that `--update-timings` refreshes every run and
CI caches across runs, so it **rotates**: a file's companions change from run to
run, and the shard a file lands on moves with the baseline. A leak then surfaces
as an intermittent failure in a file nobody touched. This is not hypothetical —
PR #951's own first CI run failed on shard 3 because `app.ts` snapshotted
`getConfig().corsOrigins` at module evaluation, so *which file imported `app`
first* decided what the CORS gate saw.

Round-robin is derived by each shard from the file set alone, so the same commit
always produces the same partition and a leak is reproducible from the SHA.
Measured on the 101-file lane (Bun 1.4.0, 85.3s total, `--shard=i/8`):

| Split                                | Critical shard | Reproducible |
| ------------------------------------ | -------------- | ------------ |
| `--timings`, balanced (rotates)      | 20.3s          | no           |
| Round-robin (what the lane now runs) | 29.9s          | yes          |

+9.6s, and cheap because one file (`spawn-runtime-child`, 20.3s) is 24% of the
lane and is the floor under *any* split — the balancing had little left to win.
Determinism verified rather than assumed: two consecutive no-timings runs
produced byte-identical partitions, union 101 files, no duplicates.

Two things this does **not** buy, so do not read more into it:

- The partition is stable for a given file set, not across them. Adding or
  deleting an integration file shifts the whole stride.
- Determinism is not immunity. It makes a leak reproducible; it does not stop
  one. Detection is [the randomized-order nightly](#randomized-order)'s job, and
  a soak of 48 shard runs across six partitions (two round-robin, four rotated)
  came back 0 fail — the class is not currently manifesting, which is the
  evidence for taking this option over unsharding the lane.

If the nightly's unisolated lane does go red on cross-file leakage, the
escalation is to unshard `api-integration` and run it whole in its own CI job the
way the frontend lane does — correct by construction, at 85.3s on the critical
path instead of 29.9s.

#### Merging is not concatenation

Bun's per-file `LF:`/`FNF:` are *run-dependent*: a source
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

This approximation is also why the frontend lane refuses to shard at all: its
coverage carries an enforced gate (see [Coverage](#coverage)), and a gate on a
number the merge can only approximate would drift with the shard count rather
than with the tests. Its single whole-run LCOV rides the same merge machinery
as a one-input degenerate case — a copy.

> **One transitional report.** The PR QA report compares a head against a
> `main` baseline. The first PRs after sharding landed compare a sharded head
> against a pre-shard baseline and show a one-time `line coverage −0.54pp`.
> Once `main` has a sharded baseline, both sides are sharded and the delta is
> real signal again. A drop after that is a drop.

#### JUnit, and the one thing it cannot carry

Every lane writes JUnit to `.mango/artifacts/junit/<lane>.xml`, and
`scripts/qa-gate/junit-results.ts` counts `<testcase>` elements out of the
test-job directories. Counts come from the elements rather than the
`<testsuites>` header because header conventions differ across runners — Bun
emits `tests`/`assertions`/`failures`/`skipped` and nests a `<testsuite>` once
per `describe`, so summing headers double-counts. A `<testcase>` is a leaf.

Unhandled errors are the exception. An error raised between tests prints a
`# Unhandled error between tests` block and a `N error` summary line and exits
1, while the JUnit report reads `failures="0"` with no failing `<testcase>`
(measured on 1.4.0-canary.1). So the failure class in
[Unhandled Errors With Green Test Counts](#unhandled-errors-with-green-test-counts)
exists only in the log, and each test job — the shards and the frontend job
alike — extracts it with `scripts/qa-gate/unhandled-errors.ts` before the log
leaves the job. If you ever replace that with a structured source, check the
reporter first rather than assuming the XML grew an `errors` count.

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

`randomized-order-nightly.yml` runs four lanes under
`--randomize --seed=<run number>` every night. It exists for the one class the
merge gate cannot see: a test that passes only because of what the file before it
left behind, which is a live hazard here while `bun test` shares one module graph
across a lane's files.

`--randomize` shuffles **file order** as well as the tests inside each file —
verified, not assumed: three probe files run as `c, b, a` under seed 3 where
seeds 1 and 2 keep `a, b, c`. File order is the half that matters for leaked
`mock.module` registrations.

**The isolation setting decides which half of the hazard a lane can detect**,
which is why the matrix carries it per entry:

| Lane              | Invocation                                | Detects                          |
| ----------------- | ----------------------------------------- | -------------------------------- |
| `api`             | `--parallel=1` over the whole workspace   | order dependence *within* a file |
| `api-integration` | no `--parallel`, over `tests/integration` | *cross-file* leakage             |
| `shared`          | `--parallel=1`                            | order dependence within a file   |
| `runtime`         | `--parallel=1`                            | order dependence within a file   |

`--parallel=1` means "one worker, *isolated*" (see [Parallelism](#parallelism)),
so a fresh global per file is exactly what hides cross-file leakage. The
`api-integration` entry deliberately re-runs files the `api` entry already
covered, in the mode the merge gate actually uses — without it, the class this
workflow exists for had no detector anywhere in CI, which is how the sharded,
unisolated lane came to rely on a rotating partition for safety.

It is deliberately not merge-gating. A suite that fails weekly on a different
seed is a bug report; making it block merges teaches everyone to re-run CI, and
that habit outlasts the fix. `fail-fast: false` keeps one red lane from
cancelling the others' evidence. A failure logs its seed and uploads the run log
under `randomized-order-<lane>-seed-<n>`, because the order **is** the finding.
Each job's log opens with the exact command to reproduce its own lane; read what
ran before the failing file rather than the failing file itself.

Every lane runs under `scripts/ci/run-tests-watchdog.ts` with
`--retry-on-crash`, because [the isolate runner can hang](#the-isolate-runner-can-hang) and can also abort outright. A hang dies at
the watchdog's per-attempt bound rather than burning the step budget, and a
crash gets one same-seed retry so the rest of the lane's file list still runs.
Both are annotated `::warning` so an infra failure does not read as an ordering
finding — but neither is allowed to hide one. The watchdog scans the crashed
attempt's log for Bun's inline `(fail)` lines, its `N fail` summary, and the
unhandled-error signal (`# Unhandled error between tests` / `N error(s)`)
that JUnit cannot carry, and reports non-zero when any is present even if the
retry came back clean: a crash proves the runner recovered, not that the
failures did not happen. A retried night keeps attempt 1 at
`run.log.attempt-1` and uploads it even when the step itself is green, since a
truncated attempt is exactly where the night's only finding may sit.

#### What it caught on its first run

The unisolated lane failed 4–5 tests on every seed tried (1, 2 and 3), in four
files that are green in the fixed order. All of them are one of three shapes,
and `--randomize` reaches all three because it reorders `it` blocks and
`describe` blocks *within* a file as well as the files themselves:

| Shape                                                      | Files                                      | Symptom                                                        |
| ---------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Per-user rows written under one fixed user id              | `settings-agents`, `settings-app-settings` | a later test reads back an earlier test's persisted settings   |
| One fixture built in `beforeAll` and shared by every test  | `chat-todos`                               | the "empty list" test reads todos a sibling test wrote         |
| `beforeAll` seeding rows a **sibling `describe`** consumes | `settings-connectors`                      | `SQLITE_CONSTRAINT_FOREIGNKEY` → 500 on every persisting route |

The third is the least obvious and the most worth remembering: `beforeAll` runs
per `describe`, so a block that authenticates as a user another block seeded
only passes while the runner happens to schedule them in that order. Because
`PRAGMA foreign_keys = ON` is set unconditionally in `src/db/database.ts`, a
missing `user` row is a hard failure rather than a silent one.

The fixes are all "own your own state", never "truncate these tables": a fresh
identity per test, fixtures minted in `beforeEach` rather than `beforeAll`, and
each `describe` seeding exactly the identities it authenticates as. Namespacing
means a test that later writes a new table cannot reopen the hole; a truncation
list means it can.

Process-wide state is the exception, because no individual suite can own it.
`setupTestEnvironment()` reinstalls the canonical test config in **both**
`beforeEach` and `afterEach`: `beforeEach` alone leaves the last test's
`loadConfigForTest` override installed through the next file's module
evaluation and `beforeAll` hooks, which both run before any `beforeEach`. That
window is where an override reaches module-level state — it once dropped
`server.allowedOrigins` for a whole shard. Suite-local `afterEach` hooks run
before the preload-registered one, so a local teardown still sees its own
override — `describe` scopes unwind inner→outer, and hooks sharing a scope run
in reverse registration order, which is what covers a test file's own top-level
`afterEach` (root scope, same as the preload's, registered later). Both verified
on Bun 1.4.0. `afterAll` is the other side of that: it runs *after* the
preload's `afterEach`, so per-file teardown cannot read the last test's
override.

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

#### Bun test runner facts

- **Coverage thresholds are enforced per file, not in total.** `bunfig.toml`'s
  `coverageThreshold` fails as soon as any one file misses the bar, so a suite
  with legitimately uncovered files cannot express a total-coverage gate
  through it. `scripts/qa-gate/enforce-coverage-thresholds.ts` reads the
  emitted LCOV back and compares floors from `scripts/lib/test-lanes.ts`
  against the suite's totals instead, chained after `test:coverage`.
- **happy-dom is registered at `http://localhost:3001`** — where the API
  really listens in dev — so a relative request a scenario never registered
  opens a real socket instead of failing fast. `bun.setup.ts` installs a
  `fetch` that rejects immediately and names the unanswered request,
  reinstalled in `afterEach`.
- **`mockReset()` strips a mock's implementation** rather than restoring it
  (the opposite of Vitest); a mock built with `jest.fn(impl)` returns
  `undefined` after a reset. `mockClear()` is the one call that means the same
  thing in both runners.
- **Bun links a mocked module's whole namespace at import.** A `mock.module`
  factory returning fewer names than the real module throws a hard
  `SyntaxError: Export named 'x' not found` from whichever *other* consumer
  imports it next — Vitest resolved lazily and let a partial factory pass
  unnoticed. Spread `const actual = await import(spec)` into any factory that
  does not cover the full module.
- **`mock.restore()` does not revert `mock.module()`.** It restores `mock()` /
  `spyOn` doubles and leaves module registrations installed for the rest of the
  process — in an unisolated lane, for every file scheduled after the one that
  registered them. `mock.module()` on an already-loaded module also *merges*
  into the live namespace rather than replacing it, so re-registering a
  hand-listed subset leaves the rest of the fake in place. The sanctioned undo
  is a whole-namespace capture (`const real = { ...mod }`) in a support module,
  re-registered from the suite's `afterEach`:
  `support/mocks/google-genai.ts` for the Gemini SDK,
  `support/connectors/index.ts` for the first-party provider modules.
  `integration/routes/_respond-stream-helpers.ts` predates this pattern: its
  `restoreAllMocks` still re-registers hand-listed subsets for seven of the
  eleven modules it covers, so it cannot undo a partial fake of any of them.
  Follow the capture pattern above in new code rather than that file's shape.
- **Never add a direct import of a mocked module to the bunfig preload.** The
  capture above has to run before any test installs a fake, which makes the
  preload look like its natural home. It is the one place it cannot go: mocking
  a module the preload imports *at top level* re-evaluates that graph, producing
  a second `test-environment.ts` whose `initialized` flag is false, and every
  later `createApiTestApp` throws the not-initialized guard. Measured on Bun
  1.4.0 — importing `@google/genai` from the preload took `--randomize --seed=1`
  over `apps/api/tests/integration` from 36 failures to 605. Transitive
  reachability is not the trigger, and the rule is not "nothing the preload can
  reach": `test-environment.ts` already pulls `@google/genai`,
  `src/services/gemini` and the openai modules in through
  `registerApplicationServices()`, and the connector suites mock all of them
  today. Import the capture from a support module test files pull in at module
  scope instead; module evaluation still precedes every hook in that file, so
  the capture is early enough in any file order.
- **Better Auth turns off origin, rate-limit and secret validation under
  `NODE_ENV=test`** (`bun test` sets it), so no `bun test` case can assert any
  of the three — the positive case passes while checking nothing and the
  negative case reads as a discovered vulnerability. `scripts/test-build.ts`
  spawns the compiled binary with `NODE_ENV=production` and is the only
  vehicle that can make that assertion.

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

Coverage reports are written under `.mango/artifacts/coverage/`, one directory
per workspace; the frontend's LCOV lands at
`.mango/artifacts/coverage/frontend/lcov.info`:

```bash
bun run --filter @mangostudio/frontend test:coverage
```

**The frontend carries total-coverage floors** — lines 81 / functions 76 /
statements 81 / branches 53, measured 2026-08-21 at 82.35 / 77.53 / 82.39 /
54.45 over the full 167-file suite and floored with ~1pt of headroom for
run-to-run LCOV jitter. (These are Bun-instrumentation numbers; the retired
istanbul 70/60/64/72 are not comparable.) The floors live in
`scripts/lib/test-lanes.ts` and are enforced by
`scripts/qa-gate/enforce-coverage-thresholds.ts`, chained inside
`test:coverage` itself, so a miss fails the same invocation CI watches — lines
and functions read from the LCOV, statements and branches derived from the
sources by `coverage-summary.ts`.

> **Why not `bunfig.toml`'s `coverageThreshold`?** Measured on Bun 1.4.0, it is
> a different feature than it looks: the threshold applies per *file* (every
> file must individually clear the bar, so one legitimately uncovered file
> fails any positive value), a key you omit still enforces a hidden ~0.9
> default, singular key names (`line`) are silently ignored, the whole gate is
> silently inert under `coverageReporter = ["lcov"]` without `"text"`, and a
> miss prints nothing — it exists only in the exit code.
> `test-lanes.unit.test.ts` pins the key's absence so it cannot come back by
> accident.

When raising or repairing coverage, prioritize release-critical surfaces first:

- Auth lifecycle routes and logout/session transitions
- Connector settings CRUD and provider validation errors
- Chat orchestration and streaming UI states
- Gallery loading, empty, pagination, and download flows

## Unhandled Errors With Green Test Counts

A frontend run can report every file and every test as passed and still print a
`# Unhandled error between tests` block — and exit 1. That is not a flake. Do
not re-run it. CI already failed correctly. The green counts are why it looks
like noise.

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

## Dangling Processes And Spawn Diagnostics

`killed N dangling process` in a `bun test` log means **a test timed out** and Bun
killed the children that test spawned. Two things about that line cost real time
in #922 and are worth knowing before you read one:

- It is a **consequence** of the timeout, not a cause. A test that leaks a child
  and passes prints nothing.
- It is printed **above** the `(fail)` it belongs to, so it reads as if the
  previous, passing test leaked something.

It also never says *which* child. `MANGOSTUDIO_SPAWN_DIAGNOSTICS=1` does:

```bash
MANGOSTUDIO_SPAWN_DIAGNOSTICS=1 bun run --filter @mangostudio/api test:integration
```

Every `Bun.spawn`/`Bun.spawnSync` and every `node:child_process`
`spawn`/`exec`/`execFile`/`fork` (and their sync forms) logs one stderr line
with the command, the pid and elapsed time, and a second line when the child
exits. A child that logs a spawn and no exit is one that outlived the run.

`bun test` on 1.4.0 exposes no current-test API — not `expect.getState()`, not a
hook argument — so events carry elapsed time rather than a test name. Interleaved
with the reporter's `(pass)`/`(fail)` lines that still places a spawn between two
named tests.

The wrappers live in `apps/api/tests/support/setup/spawn-diagnostics.ts` and are
installed by that workspace's preload only, so this is an api-lane instrument.
The CI test lanes set the flag (`.github/workflows/test.yml`); unset, nothing is
installed and nothing is paid for.

> **Local is in-process.** There is no runtime child process for the `local`
> environment — `createLocalRuntimeConnector` builds a `RuntimeHost` inside the
> hub. A test suite that connects Local per test does spin one host per test,
> and each host probes `git --version` synchronously. Connect once per file
> instead; the checkpoint suites are the worked example.

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

| Family                | Producer / consumer           | Path                            | Invalidators                                             | Restore behavior                  |
| --------------------- | ----------------------------- | ------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Bun install           | every job using `setup-mango` | `~/.bun/install/cache`          | OS, arch, Bun revision, lockfile                         | loose trusted-`main` prefix       |
| Turbo task output     | check, test, build            | `.turbo/cache`                  | OS, arch, Bun revision, Turbo version, lane, task config | lane-scoped trusted-`main` prefix |
| TypeScript build info | check                         | `.mango/artifacts/tsbuildinfo/` | TypeScript version, tsconfig graph, TS sources           | version-scoped trusted-`main`     |
| Workflow lint tools   | check                         | `.mango/artifacts/tools/`       | pinned tool manifest                                     | exact trusted restore only        |
| Playwright browser    | browser smoke                 | `~/.cache/ms-playwright`        | OS, arch, Playwright version                             | exact trusted restore only        |

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
