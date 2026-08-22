---
name: bun-frontend
description: Facts, recipes and the parity gate for replacing Vite/Vitest in apps/frontend with the Bun toolchain. Read this before writing OR reviewing any change to the frontend bundler, dev server, or test harness — vite.config.ts, vitest.config.ts, Bun.build(), bunfig.toml preloads, happy-dom setup, migrating a test off vitest, how the API serves dist/, or a diff on the refactor/bun-frontend branch. Carries the measured traps (publicPath, mock.module leakage, the fd leak, dist/ layout) that a plausible-looking change silently breaks.
---

# Bun frontend migration

`apps/frontend` moved off Vite and Vitest onto one bundler (Bun), one test runner
(`bun test` + happy-dom) and one server (Elysia) in dev and in the shipped binary. The
migration landed through `refactor/bun-frontend`; the ledger below is the review checklist
for any later change to the frontend build or test harness.

Target-state architecture: `docs/architecture/frontend-build.md`.

## How to use this file

- **Authoring** a migration step: read the ledger first, then the mechanics table.
- **Reviewing** a diff: the ledger is the checklist. Most entries below describe a failure
  that `bun run check`, `bun run test` and `verify` are all blind to, so "CI is green" is not
  an answer to any of them.
- **Verifying** something new: append it to the ledger with what was measured, when, and on
  what. The ledger is what stops the same trap being re-derived in the next PR.

## Verified facts ledger

Measured or read from a primary source on 2026-08-20 unless noted.

**T1 — `bun build` CLI has no plugin flag.** Plugins load only via `Bun.build({ plugins })` or
`bunfig.toml [serve.static] plugins`. Because Tailwind v4 goes through `bun-plugin-tailwind`,
production builds *must* go through `Bun.build()` in a script. `bun build ./index.html
--outdir=dist` cannot carry Tailwind.

**T2 — the SPA fallback must return a `Response`, never the bundle.** Elysia
[#1515](https://github.com/elysiajs/elysia/issues/1515) (open): an `HTMLBundle` returned from
an error handler gets JSON-serialized. `apps/api/src/server/frontend-static.ts` returns
`new Response(Bun.file(indexPath))`, which is safe — do not "simplify" it to return the
imported bundle. The same issue documents that `get('/*')` shadows `.use()`/`.mount()` routes,
which is why `registerEmbeddedSpa` registers one explicit GET per asset instead of a root
wildcard. Preserve that shape.

**T3 — ~~`await staticPlugin()` enables the fullstack dev server~~. Moot: there is no
fullstack dev server.** Superseded by T20. Bun's HTML-bundle path is unusable for this app, so
dev serves a built `dist/` through the ordinary directory branch and `staticPlugin` is
constructed exactly as production always did. Do not reopen this; the reason is T20, not the
`await`.

**T4 — the fd leak is still live upstream on Bun 1.4.0.** `oven-sh/bun#37968` is open (updated
2026-08-19) and its fix `#38008` is open and unmerged; both re-verified via `gh api` on
2026-08-20. 1.4.0 contains no workaround — it only made the collision stop being observable.
A green run is not evidence the defect is gone.

**T5 — measured at frontend scale.** A synthetic 167-file happy-dom lane on released Bun
1.4.0, pinned with `taskset -c 0-3`:

| Config                             | Runs | Result                                   |
| ---------------------------------- | ---- | ---------------------------------------- |
| `--isolate`, no `--parallel`       | 1    | 167 pass, 0 `epoll_ctl`, 16.69s          |
| `--parallel=4`                     | 6    | 6/6 exit 0, 0 `epoll_ctl`, 0 hangs, 5–6s |
| stderr-pipe dups under `--isolate` | 1    | climbs 4 → 16 across 167 files           |

**`--parallel` divides the accumulation; serial isolation concentrates it.** Against a defect
that is fd-number *reuse* colliding with a stale epoll registration, `--parallel=4` spreads 167
files' stale registrations across four processes (~42 each) while `--isolate` alone piles all
167 into one. Serial isolation has *more* collision surface, not less — it is not the
conservative choice it looks like.

Two caveats on those numbers: (a) synthetic files have a trivial module graph, and the real
suite's per-file graph is what drives fd churn; (b) the dup rate here is ~25× slower than the
2-fds-per-file that #38008's own 8-file fixture produced, so treat the rate as indicative and
the *direction* (it climbs) as the finding. This is evidence the config is not obviously
broken, not proof it is safe.

**T6 — happy-dom needs two preload files, in order.** `GlobalRegistrator.register()` must live
in a file that does **not** import `@testing-library/react`. Bun runs preloads sequentially; if
registration and the testing-library import share a file, `@testing-library/dom` evaluates
before `document` exists on `globalThis` and `screen` silently initializes broken. Bun's own
docs show two files without explaining why.

**T7 — the `dist/` layout is reproducible, so the API side is nearly zero-change.**
`scripts/lib/embed-frontend.ts:36` enumerates `dist/` generically and hardcodes nothing. Only
`apps/api/src/server/frontend-static.ts:88` special-cases `/assets/` (immutable
`Cache-Control`). `Bun.build({ naming: { entry, chunk, asset } })` reproduces `dist/index.html`

- `dist/assets/*-[hash].*`, so `embed-frontend.ts`, `runtime-paths.ts`, `doctor-checks.ts` and
  `frontend-static.ts` all stay untouched.

**T7b — `publicPath: '/'` is mandatory.** Confirmed empirically: `Bun.build()` with the T7
`naming` block produced exactly `dist/index.html` + `dist/assets/index-[hash].css` +
`dist/assets/index-[hash].js`. But **by default Bun rewrites the HTML to *relative* asset
URLs** (`href="./assets/…"`) where Vite emits absolute (`/assets/…`). That silently breaks
every deep link: the SPA shell served at `/settings/agents` resolves `./assets/x.js` to
`/settings/assets/x.js` → 404, blank page, no server-side error. `publicPath: '/'` in the
`Bun.build()` options emits `href="/assets/index-[hash].css"`. Non-negotiable — and invisible
to every automated gate, so a reviewer has to look for it.

**T8 — `motion/react` aliasing must stay resolver-level.** Vitest does it via `resolve.alias`.
Under `bun test` use `tsconfig.json` `paths` or `package.json` `imports` — **not**
`mock.module`. See the mechanics section for why.

**T9 — `--parallel=0` is an error**, not "auto". Bare `--parallel` means CPU count. A repeated
flag takes the last value.

**T10 — CORS `+1` port bumping becomes dead code.** `apps/api/src/lib/config.ts:605` builds
four CORS origins from `frontend.port` "(include +1 for Vite port bumping)". Once the frontend
is same-origin the whole block is vestigial.

**T11 — `bun-plugin-tailwind@0.1.2` works against `tailwindcss@4.3.3`.** `Bun.build()` with
`plugins: [tailwind]` returned `success: true` and emitted a 6152-byte CSS file containing
every probed utility including a responsive variant (`flex`, `items-center`, `gap-4`,
`text-emerald-500`, `md:grid-cols-3`) — the scanner ran and tree-shaking worked; it did not
fall through to a no-op or dump the full framework. The plugin's staleness (0.1.2, ~9 months)
is a maintenance risk, not a correctness one.

**T12 — the test lane registry lives in `scripts/lib/`, not just `package.json`.**
`scripts/lib/test-lanes.ts` defines `TestLaneId` with a `'frontend-vitest'` member, `runner:
'bun' | 'vitest'`, per-lane `junitPath`/`timingsPath`, `COVERAGE_PATHS` and `VITEST_BLOB_DIR`.
`scripts/lib/test.ts` has `laneById('frontend-vitest')`, `MANGOSTUDIO_VITEST_ARGS` and a
`consoleReporters()` helper that reproduces `vitest.config.ts`'s reporter choice.
`scripts/test.ts` orchestrates from these. Editing only `apps/frontend/package.json` and
`test.yml` leaves the orchestrator referencing a lane that no longer exists.

**T13 — a top-level HTML import reaches the binary build.** Bun's bundler statically analyzes
`import` *and* `await import()`, so an `import index from '…/index.html'` placed directly in
`frontend-static.ts` is evaluated by `bun build --compile` too — pulling the frontend source
graph into a binary that already embeds the built `dist/` via the generated manifest. The repo
has met a version of this already: `frontend-static.ts:102` records that `htmlBundle.default is
undefined for Vite-generated HTML` inside a compiled binary. The fix is a **module boundary**,
not a runtime `if` — the shape `embedded-frontend.ts` already uses, where only the generated
binary entry populates the registry.

**T14 — both bundlers emit an 8-character content hash, but not the same alphabet.**
Vite/rollup writes base64url (`index-Bqugzlgv.js`, and it can contain a `-`:
`json-qhed-kSA.js`); `Bun.build()` writes lowercase base36 (`entry-htt6v99t.js`). Roughly 4%
of Bun's hashes contain no digit at all, so anything that tries to recognize a hash by "it
looks random" misfires at random. `scripts/ci/frontend-bundle-report.ts` keys on suffix length
instead, for that reason.

**T20 — Bun's HTML *entrypoint loader* silently drops a transitive import from this app's
graph. Never give Bun an HTML entrypoint.** Measured 2026-08-21 on Bun 1.4.0 with real headless
chromium loads (`playwright-core` + `~/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome`):

| entrypoint       | browser result                                              |
| ---------------- | ----------------------------------------------------------- |
| `./index.html`   | `pageerror: atom is not defined`, `#root` empty, blank page |
| `./src/main.tsx` | app renders, Tailwind applies, **zero console errors**      |

`atom` is better-auth's `nanostores` import. The same failure appears through
`Bun.serve({ routes: { '/': htmlBundle } })` and through `app.listen({ routes })` — so the
common factor is the HTML loader, not `Bun.serve`, not Elysia's two-phase boot, and not the
`development` flag (all three of `true` / `false` / omitted fail). `splitting: true` is **not**
the trigger; it was ruled out explicitly.

That is why there is no HMR and why `apps/frontend/build.ts` stitches `index.html` by hand.
`bun build ./index.html` also fails *hard* on the four absolute `public/` hrefs
(`error: Could not resolve: "/favicon.ico"`) — a TS entrypoint never parses the HTML, so that
problem disappears too.

Related upstream, but **not** the same bug: `oven-sh/bun#34357` (`var [arguments, eval] =
hmr.imports` from typebox's `build/system/arguments/`) is closed *by the reporter*, not by a
fix; the actual fix `#34361` is open and unmerged. It would only address the `arguments`
SyntaxError. Even if it lands, the dropped-import bug above is untouched.

**T18 — `naming.entry` and `naming.chunk` must not share a pattern, and the stitch must resolve
by `kind`.** Under `splitting: true` Bun names a dynamic-import chunk after the entry that
reaches it, so one pattern for both produced **18 files matching `assets/main-*.js`**. A
glob-based stitch then picks a chunk instead of the entry and the page renders **blank with
zero console errors** — no diagnostic at all. Use a `chunk-` prefix *and*
`result.outputs.find(o => o.kind === 'entry-point')`.

**T19 — `reactCompiler: true` really runs on Bun 1.4.0** (compare `Bun.Archive.write`'s
accepted-and-ignored `mode`). Unminified A/B on the same entrypoint: `false` → 7,462,834 bytes,
**0** `$[n]` memo slots, 0 `compiler-runtime` imports; `true` → 8,102,894 bytes, 769× `$[0]`,
2 `compiler-runtime` imports. Cost measured against the Vite baseline: the bundler swap alone
is **+11.1% gzip**, and the compiler adds **another ~+205 kB gzip** on top for **+33.6%** total.
It is a behavior change, not parity — `vite.config.ts` ran `@vitejs/plugin-react` without it.

**T21 — `@types/bun` must track the pinned runtime.** `reactCompiler` is absent from
`BuildConfig` in `bun-types@1.3.14`, so a correct `Bun.build()` call fails `tsc` with
`TS2353` while running fine. Bumped to `^1.4.0` in all four `package.json` files;
`root:dependency-cohort` requires they agree.

**T22 — `getDefaultFrontendDir()` resolves against `process.cwd()`, and Turbo runs the API's
dev task from `apps/api`.** So dev needs `dev-frontend-dir.ts`, a get/set seam populated only
by `src/dev.ts`. Resolve the frontend directory from `import.meta.dir`, never the cwd.

**T23 — plain `app.listen()` is enough; the raw-`Bun.serve()` WS shim is not needed.** Verified
live against `bun run dev`: `/api/ws` and `/api/runtime` both upgrade (`OPEN`), and `/api/*`,
`/api/auth/*`, `/scalar`, `/uploads/*`, `/images/*` all return their own content-type rather
than the SPA shell. An earlier iteration hand-rolled `Bun.serve({ routes, websocket, fetch })`
plus `app.server = server` and Elysia's undocumented `buildGlobalWSHandler()`; that is only
required when passing an HTML bundle through `routes`, which T20 rules out.

> "Not the SPA shell" was the wrong assertion to check. `/api/auth/*` was answering a JSON
> 404 — its own content-type, and still broken. See T24.

**T24 — `staticPlugin({ prefix: '/' })` registers `GET /*`, and on `.listen()` that outranks
every `.all('/*')` route in the app.** `alwaysStatic` keys off `NODE_ENV === 'production'`,
which nothing in this repo sets, so `@elysia/static@2.0.0-beta.2` always takes the branch at
`dist/index.js:66` that mounts the catch-all. Once Elysia promotes routes into Bun's native
table, that root wildcard swallows every `.all('/*')` — at the root, inside a `.group()` and
inside a mounted prefixed instance alike. **The method is the discriminator, not the nesting:**
measured on the pre-fix code, `.all('/x/*')` was shadowed at all three depths while
`.get('/y/*')` was reached at all three. So Better Auth (mounted `.all('/*')` in
`routes/auth.ts`) 404'd every path but the literal `/ok`, and `/images/*` + `/uploads/*` —
both `.get` — were never affected. Verify with a real file before claiming a `.get` wildcard
is broken; a missing file 404s either way and proves nothing.

**`app.handle()` resolves the same request correctly**, which is why nothing caught it: every
route integration test drives `handle()`, `static-routes.integration.test.ts` only exercises
the pure `isSpaRoute()`, and `test-build.ts` runs the binary, which takes the
`registerEmbeddedSpa` branch (explicit per-file routes, no wildcard — its doc comment has
warned about exactly this since #454). The bug predates this migration; serving the frontend
from the API in dev is what made it user-visible.

Fix in `registerSpa`: narrow the plugin to `prefix: '/assets'` (hashed filenames change on
every rebuild, so they must stay behind a dynamic route) and register one explicit route per
unhashed root file. Guard test: `frontend-static.test.ts` → "over a listening server", which
binds port 0 and asserts a stand-in `.all('/*')` stays reachable, with a `.get('/*')` control
so it cannot pass for the wrong reason. **Any new frontend-serving branch needs a test that
binds a real port**; `handle()` is blind to this whole class.

**T25 — `Bun.build()` honours `tsconfig.json` `paths`, so a test alias there ships.** Measured
2026-08-21: with `"motion/react": ["./sub/stub.ts"]` in the tsconfig at the build's cwd, the
stub's marker string appears in the bundled output, `success: true`, no warning. `Bun.build()`
has no `tsconfig` option to opt out of. So T8's aliases cannot live in
`apps/frontend/tsconfig.json`; they live in `tsconfig.test.json` and reach `bun test` through
the global `--tsconfig-override` flag. Three things about that flag:

- **`bunfig.toml`'s `[test] tsconfig = "…"` is accepted and silently ignored.** With the key
  set, `motion/react` resolved to the real package (383 exports); with the flag, to the stub
  (2). A run that "passes" against the wrong module looks identical.
- **`paths` does not merge through `extends`** (ordinary TS semantics), so `tsconfig.test.json`
  restates `@/*`. `tests/unit/bun-lane-harness.test.ts` fails if the two drift.
- Every invocation prints `Internal error: directory mismatch for directory "…"` to stderr —
  once per process, so 1 serial and N+1 under `--parallel=N`. Cosmetic Bun bug; exit code and
  results are unaffected.

**T26 — the frontend lane must not be able to reach the network.** happy-dom is registered at
`http://localhost:3001/`, which is where the API really listens in dev, so a relative request
no scenario answered opens a real socket. Measured: a nine-file run printed `connect
ECONNREFUSED 127.0.0.1:3001` attributed to two files that issue no requests at all — the
connection outlived the file that started it and Bun blamed whichever file was running. Green
counts, an error block, a stack pointing at the wrong test. `bun.setup.ts` installs a `fetch`
that rejects immediately and names the unanswered request, and reinstates it in `afterEach`.

**T27 — Bun 1.4.0 has no async timer advance, and dropping a queued callback wedges React
Query.** `jest.advanceTimersByTimeAsync` and `runAllTimersAsync` are `undefined`;
`advanceTimersByTime` exists and throws `Fake timers are not active` when they are not.
`Date.now()` does move with the fake clock. The trap: React Query schedules every cache
notification through `notifyManager`'s live `setTimeout(callback, 0)`
(`query-core/timeoutManager.js:73`), and whatever is still queued is discarded at
`useRealTimers()` — after which the manager never delivers again. Measured: one fake-timer
test made the *next* test in `use-settings-realtime.test.ts` time out at 5s while both passed
alone. `support/harness/timers.ts` wraps all three calls; use it rather than `jest` directly.

**T28 — `mockReset()` means opposite things in the two runners.** Vitest restores the
implementation `vi.fn(impl)` was given; jest and `bun test` strip it, so the mock starts
returning `undefined`. `create-fetch-scenario.restore()` used it, and under `bun test` that
turned every test after the first in a file into a failed request (measured: 10 of 13 in
`tool-settings-page`). `mockClear()` is the one that means the same thing in both.

**T29 — the `vi` surface `bun test` simply does not have.** Probed on 1.4.0:
`jest.resetModules`, `isolateModules`, `mocked`, `hoisted`, `stubEnv`, `unstubAllEnvs`,
`stubGlobal`, `waitFor` and `runAllTicks` are all `undefined`; `mock.module`, `mock.restore`
and `mock.clearAllMocks` live on `mock`, not on `jest`. Three consequences worth knowing
before reaching for a workaround:

- **`import.meta.env` is backed by `process.env`**, so `vi.stubEnv` ports to a plain
  `process.env.X = …`. Assign `undefined` and you leave the *string* `"undefined"` behind,
  which reads as a set value — `delete` it.
- **A cache-busting query really does re-evaluate a module** (`import('@/lib/x?fresh=1')`
  returned a different instance than `import('@/lib/x')`), which is the only genuine
  `resetModules` substitute. But knip cannot follow that specifier and reports the module's
  exports as unused, failing `bun run check`. Same for a module-scope
  `const ns = await import('@/lib/x')` you then member-access: knip traces *that* and flags
  whatever the test does not touch. Keeping the dynamic import behind a function is what
  stays opaque to knip — which is why `shiki.test.ts` has one.
- `toHaveBeenCalledExactlyOnceWith` is a Vitest matcher with no Bun equivalent; the
  `toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(…)` pair says the same thing.

**T30 — `bun-types` types `toEqual` against the *received* value; Vitest's took `unknown`.**
So an expected literal that is not assignable to the received type compiled fine there and
fails `tsc` here — a mock returning a partial payload, a union member the contract does not
list, a `done: false` where the type says `true`. `expect<unknown>(received).toEqual(…)`
widens it. It is **not** the general answer to a `tsc` error: anywhere the runtime value does
not provably escape its declared type, the error means the expected shape is wrong.

**T31 — Bun links a mocked module's whole namespace at import.** Vitest resolved lazily, so a
factory returning one or two names often went unnoticed by that module's *other* consumers.
Under `bun test` a missing export is a hard `SyntaxError: Export named 'x' not found in
module '…'`, surfaced as `# Unhandled error between tests` — one test fails and the message
points at neither the mock nor the consumer. Measured on `@/services/external-agent-service`,
`@/features/chat/queries` and `@/features/settings/connectors/api`. Any factory returning
fewer names than the real module exports needs `const actual = await import(spec)` spread in.

**T32 — happy-dom is not jsdom, in two ways that are invisible until they are not.** The
origin is `http://localhost:3001`, not jsdom's `http://localhost:3000`: `safe-redirect.test.ts`
had hard-coded the latter, so its *same-origin* cases were silently exercising the
cross-origin path. And `navigator.clipboard` is a readonly getter where jsdom left it
writable — `Object.assign(navigator, { clipboard })` throws `Attempted to assign to readonly
property`; define and restore the descriptor instead.

**T33 — the `act(...)` warnings that only exist in a full-lane run.** Nine real ones were
found migrating 156 files, and **not one reproduced when its file ran alone** — the update
lands inside the test body on an idle machine and after it under load, so a per-file check is
blind to the whole class. Four shapes, all fixed at the source rather than silenced:

| shape                                                          | fix                       |
| -------------------------------------------------------------- | ------------------------- |
| a query resolving behind a synchronous `getByTestId`           | `await screen.findBy…`    |
| a dropped `renderWithRouter(…)` promise (it is async)          | `await` it                |
| an async submit handler continuing after `user.click` resolves | drive it inside one `act` |
| a `lazy()` chunk settling after the assertions                 | `flushAsyncRender()`      |

`flushAsyncRender()` (`support/harness/render.tsx`) advances one macrotask inside `act`. It
must not run while fake timers are installed — a `setTimeout` does not fire on its own then,
and an `afterEach` that ignored this would hang the run rather than flush it. An `afterEach`
flush does **not** work for this class anyway: the resolution happens mid-test, not after it.

Also from that volume, and not a Bun fact: **biome's `noComponentHookFactories` rejects a
component defined inline in a `mock.module` factory** — which is exactly the shape every
`Link` stub had under `vi.mock`. Declare the stub at module level and reference it.

**T34 — `bunfig.toml`'s `coverageThreshold` cannot express a total-coverage gate.** Measured
2026-08-21 on released 1.4.0, fixture and real suite agreeing:

- **It is enforced per *file***: every file must individually clear the bar. A two-file
  fixture at 33%/100% lines fails `lines = 0.34` and passes `0.3`; the real 167-file suite
  (82–83% totals, some files legitimately 0%) fails every positive value.
- Keys are **plural** (`lines` / `functions` / `statements`); singular names are accepted and
  silently ignored.
- A key you **omit** is not "no gate" — it keeps a hidden ~0.9 default, so `{ lines = 0.5 }`
  fails a suite whose functions sit at 50% with no mention of functions anywhere.
- The whole gate is **silently inert under `coverageReporter = ["lcov"]`** without `"text"` —
  the check lives in the text reporter's path (Bun's docs now say so).
- A miss prints **nothing at all**; it exists only in the exit code.

Hence `scripts/qa-gate/enforce-coverage-thresholds.ts`: it reads the emitted LCOV back and
compares *totals* (lines/functions from LCOV, statements/branches source-derived via
`coverage-summary.ts`) against floors in `scripts/lib/test-lanes.ts` — chained after
`bun test --coverage` inside the frontend `test:coverage` script, so a miss fails the lane's
own invocation. Floors 81/76/81/53 against measured 82.35/77.53/82.39/54.45; observed
run-to-run jitter on an unchanged suite was 0.03pp (82.35 → 82.32 lines).

**T35 — the D7 soak: `--parallel=4` is clean on the real suite.** Twelve runs of
`taskset -c 0-3 bun test --tsconfig-override=./tsconfig.test.json --parallel=4
--timeout 15000 tests` on 2026-08-21: **12/12 exit 0, 1397 pass / 0 fail every run, zero
`epoll_ctl`, zero hangs, 33–34s per run** against the ~102s pinned serial baseline (the
plan's soak command omitted the tsconfig flag; it must not be omitted). `test:coverage`
now carries `--parallel=4 --isolate`; the fallback if CI ever reproduces #37968 is
`--parallel=2`, not serial (T5). The only stderr signal, in 5 of 12 runs, was the
previously unattributed `act(...)` warning — root-caused to
`tests/unit/features/library/backup-usage.test.tsx` asserting *absence* synchronously while
its mocked usage query resolved after the test ended; fixed with `flushAsyncRender()`
before the `queryByTestId` check. Unpinned on 28 cores the same coverage invocation runs in
~30s.

**T36 — `Bun.build()` defaults `process.env.NODE_ENV` to `'development'`, and that ships
dev-mode React in a minified production bundle.** Measured 2026-08-21 via metafile/sourcemap
inventory: without a define, the bundle contained `react-dom.development.js`,
`react.development.js`, `scheduler.development.js` and dev-only `@tanstack/router-core` /
`motion` modules — Vite inlined `'production'`. Cost: +78 kB gzip on the eager payload plus
React's dev-mode runtime checks, invisible to `check`, `test` and the browser smoke (the app
renders identically). The fix is an explicit
`define: { 'process.env.NODE_ENV': '"production"' }` in `build.ts`. This was most of the
"bundler swap" size regression: with it, eager parity vs Vite is +3.7% gzip
(551.2 vs 531.5 kB js-only) and the rest is the React Compiler's owner-accepted +204 kB
(T19/D8). Also measured then: **zero modules duplicated across chunks** (the 009 plan's
duplication hypothesis was an artifact of measuring the dev-React bundle), splitting off
would hoist everything into one 1047 kB eager chunk (keep `splitting: true`), and 1.4.0's
`Bun.build({ metafile: true })` returns a typed esbuild-style metafile — `build.ts` writes it
to `apps/frontend/dist-metafile.json` (gitignored) and the bundle report's duplicate-module
check reads it. `production: true` also exists at runtime but is not in `bun-types` 1.4.0
(T21 applies); the define is the typed spelling.

**T37 — `env: 'PREFIX_*'` cannot ship a build-time variable to a browser; use a `define`.**
Measured 2026-08-21 on 1.4.0, found by review of PR #916's first attempt. The `env` option
rewrites only the exact `process.env.X` member read — never `import.meta.env.X` — so the
Vite-era `import.meta.env?.VITE_API_URL` read was silently dead all branch (split-deployment
override lost, invisible behind the `window.origin` fallback). Worse, the two obvious repairs
both fail: an **unset** variable survives into the bundle as the verbatim expression (bare
`process` → ReferenceError in a browser), and wrapping it in
`typeof process !== 'undefined' ? process.env.X : undefined` makes the inlined value
unreachable — the guard stays in the bundle, evaluates false in a browser, and **discards the
literal that `env` just inlined**. The unit test passes either way because `bun test` has a
real `process`. The working shape is the T36 mechanism:
`define: { 'process.env.MANGO_API_URL': JSON.stringify(resolveApiUrlOverride()) }`
(always defined, `''` when unset) plus a bare `process.env.MANGO_API_URL` read in
`api-base-url.ts`. Verify by grepping the built bundle for the literal **and confirming no
`typeof process` adjacent to it**, then a headless render.

Renamed from `VITE_API_URL` on 2026-08-21 — it was named after a bundler this repo no longer
has, and the prefix sends readers hunting for a `vite.config.ts` that does not exist.
`build.ts`'s `resolveApiUrlOverride()` still accepts the old name for one release and warns.
Note what the *unset* case looks like in a shipped bundle: the minifier drops the whole
`if (explicit)` branch, so grepping a release artifact for the variable finds nothing at all —
that absence is correct, not evidence the define regressed.

**T38 — `BunFile.stat()` returns `undefined` for a file embedded in a compiled binary, and it
is not a promise.** Measured 2026-08-21 on the pinned 1.4.0 with `bun build --compile` over an
`import f from './asset.txt' with { type: 'file' }` entry. Three shapes, and they do not agree:

| file                 | `stat()`                | `exists()` | `size` / `text()`                    |
| -------------------- | ----------------------- | ---------- | ------------------------------------ |
| on disk, present     | resolves `Stats`        | `true`     | real                                 |
| on disk, missing     | **rejects** `ENOENT`    | `false`    | 0                                    |
| embedded in a binary | **returns `undefined`** | `true`     | real size, `lastModified` a sentinel |

So `await file.stat().catch(() => null)` — the obvious shape, and the one `frontend-static.ts`
shipped — is a **synchronous `TypeError: undefined is not an object`** on the embedded row,
thrown out of the request handler. It cost every unhashed root asset the binary serves
(`/favicon.ico`, `/icon-192.png`, `/apple-touch-icon.png`, `/site.webmanifest` — all four
referenced by `index.html`) a 500. Catch around the `await`, then use **`exists()` as the
discriminator** between "embedded, no inode" and "gone"; there is nothing to revalidate against
on the embedded row, so it gets `Cache-Control` and no ETag.

Blind to every gate but one: the `registerEmbeddedSpa` unit fixtures map URL paths to real temp
files, which stat fine, so `bun test` cannot reach the row that breaks. `scripts/test-build.ts`
now fetches `/favicon.ico` from the running binary — per the parity gate below, it is the only
thing that runs the compiled artifact at all.

**T39 — `Bun.serve` answers 500, with its own HTML error page, when a `Response` body is a
`Bun.file` that is not there.** Measured 2026-08-21 on 1.4.0: not a 404, and the body is
`<!doctype html>`, so a caller sniffing content-type sees an HTML shell where it expected an
asset. `dist/` is absent for the whole `rm`-to-rebuild window of every dev save (`build.ts`
removes it first), which made `GET /` and every deep link 500 until the build finished. Any
handler that hands `Bun.file` to a `Response` needs an existence check first — `serveIndexFile`
is reached through `registerSpa`'s `serveIndex` and through the SPA fallback, so the guard
belongs on the shared closure, not on the route.

**T40 — Bun's URL parser normalises `%2e%2e` away but passes `..%2f` through verbatim.**
Measured 2026-08-21 on 1.4.0, against `new URL(req.url).pathname` inside a `Bun.serve` handler:

| request         | `pathname` a handler sees |
| --------------- | ------------------------- |
| `/%2e%2e/x.txt` | `/x.txt`                  |
| `/../x.txt`     | `/x.txt`                  |
| `/sub/../x.txt` | `/x.txt`                  |
| `/..%2fx.txt`   | `/..%2fx.txt`             |

So any handler that resolves a filesystem path from a URL has to `decodeURIComponent` **and
then** re-check the segments — the `..` in the last row is invisible until after the decode,
and it is the only one of the four that still reaches the handler. The trap for a test author
is the mirror image: a traversal case written with `%2e%2e` is **vacuous**, because the parser
already neutralised it before any code under test ran. `frontend-static.ts`'s
`resolveUnhashedFile` decodes, rejects `.`/`..`/empty/backslash/NUL segments, and then confirms
containment with a `realpathSync` prefix comparison so a symlink inside `dist/` cannot resolve
outward either.

**T41 — Better Auth turns three security gates off when `NODE_ENV=test`, so `bun test` cannot
assert any of them.** Measured 2026-08-21 on better-auth 1.6.26 / Bun 1.4.0. From better-auth's
own `dist/context/create-context.mjs`:

| gate               | line | default                                               |
| ------------------ | ---- | ----------------------------------------------------- |
| origin + form CSRF | :210 | `skipOriginCheck: isTest() ? true : false`            |
| rate limiting      | :171 | `enabled: options.rateLimit?.enabled ?? isProduction` |
| secret validation  | :40  | `validateSecret()` returns early `if (isTest())`      |

and `@better-auth/core/dist/env/env-impl.mjs:36` — `const isTest = () => nodeENV === "test" ||
toBoolean(env.TEST)`. `bun test` sets `NODE_ENV=test`. `apps/api/src/auth.ts` sets neither
`advanced.disableOriginCheck` nor a root `rateLimit` (the `rateLimit: { enabled: false }` there
is inside the `apiKey({ … })` plugin block), so all three take the environment default.

The same five requests, `POST /api/auth/sign-up/email`, trusted list
`["http://localhost:3001","http://127.0.0.1:3001","http://0.0.0.0:3001","https://studio.test"]`:

| request                                | in-process, `NODE_ENV=test` | compiled binary, `NODE_ENV=production`    |
| -------------------------------------- | --------------------------- | ----------------------------------------- |
| no `Origin` at all                     | 200                         | 200                                       |
| foreign `Origin`, no cookie            | 200                         | **403** `INVALID_ORIGIN`                  |
| foreign `Origin` + cookie              | 200                         | **403** `INVALID_ORIGIN`                  |
| foreign `Origin` + cross-site navigate | 200                         | **429** (rate limit, not the origin gate) |
| trusted `Origin`                       | 200                         | 200, then 429                             |

**The rule: an assertion about origin rejection, rate limiting, or auth-secret validation cannot
be written as a `bun test` case — it is vacuous by construction.** Same failure shape as T40: the
environment neutralised the input before the code under test ran. It is worse here because it is
self-confirming in both directions — the obvious positive test passes while checking nothing, and
the obvious *negative* test sees a 200 and reads as a discovered vulnerability. Both happened in
one session, and the second was relayed as "Better Auth does not behaviorally enforce
`trustedOrigins` on any endpoint this app enables". That claim is false; production enforces.

Three things not to re-derive:

- **`no Origin at all` being 200 is correct, in both columns.**
  `dist/api/middlewares/origin-check.mjs:95` returns early unless `forceValidate || headers.has("cookie")`
  — a cookieless request with no `Origin` carries no ambient authority; it is `curl`, not CSRF.
  `sign-up`/`sign-in` additionally mount `formCsrfMiddleware` (`dist/api/routes/sign-up.mjs:25`,
  `sign-in.mjs:214`), which escalates to `validateOrigin(ctx, true)` as soon as **any** `Origin`,
  `Referer` or `Sec-Fetch-*` header is present. That is the row a probe should target.
- **The 429s are the second gate, not a flake.** Rate limiting is production-only, so it appears
  for the first time exactly where these probes run and nowhere a developer looks. Probe B saw it
  after roughly four sign-ups — space the cases or reuse one, or a 429 gets misread as the origin
  check.
- **`scripts/test-build.ts` is the only vehicle.** It already spawns the binary with
  `NODE_ENV: 'production'`, and per the parity gate below it is the only thing that runs the
  compiled artifact at all. Do not force the check on under test with
  `advanced.disableOriginCheck: false`: that makes `bun test` diverge from dev *and* prod on a
  security path, and the API harness carries no per-suite origin.

The gates that *are* ours — the Elysia CORS middleware in `app.ts` and the realtime handshake in
`realtime-routes.ts` — read the same `cfg.corsOrigins` and do run under `bun test`. Their tests
sit next to the Better Auth one and look interchangeable with it. They are not.

## Test migration mechanics

Everything below is what the 004 spike actually needed across its eleven files. Where a row
says "harness", the wrapper is in `apps/frontend/tests/support/` and exists for a measured
reason — use it rather than the raw call.

| Vitest                             | `bun test`                                                              |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `import { vi } from 'vitest'`      | `import { jest, mock, spyOn } from 'bun:test'`                          |
| `vi.fn()` / `vi.spyOn`             | `jest.fn()` / `spyOn` from `bun:test`                                   |
| `vi.mocked(x)`                     | no equivalent — keep the `jest.fn()` handle the factory returned        |
| `vi.mock('@/x', factory)`          | `mock.module` + `await import()` of the module under test, **after** it |
| `vi.hoisted(() => …)`              | a plain `const` above the `mock.module` call; nothing is hoisted        |
| `vi.useFakeTimers()`               | `useFakeTimers()` from `support/harness/timers` (T27)                   |
| `vi.useRealTimers()`               | `await restoreRealTimers()` from the same module (T27)                  |
| `vi.advanceTimersByTimeAsync(n)`   | `await advanceTimersByTimeAsync(n)` — Bun has no async advance (T27)    |
| `vi.waitFor(fn)`                   | `waitFor` from `@testing-library/react`                                 |
| `vi.stubGlobal(k, v)`              | `globalThis[k] = v`, restored by hand — no `unstubAllGlobals` exists    |
| `expect(m).toHaveBeenCalledOnce()` | `toHaveBeenCalledTimes(1)` — the matcher runs but `bun-types` omits it  |
| `resolve.alias`                    | `tsconfig.test.json` `paths` + `--tsconfig-override` (T8, **T25**)      |
| `globals: true`                    | explicit imports from `bun:test`                                        |
| `environment: 'jsdom'`             | happy-dom via the two-file preload (T6)                                 |
| `setupFiles`                       | `bunfig.toml` `[test] preload`                                          |

**`mock.module` is not undone by `mock.restore()`, and it does cross files.** Measured on Bun
1.4.0 with a two-file fixture: file A mocks `./real.ts`, file B imports it and sees `MOCKED`
under the default runner and under `--parallel --no-isolate`, and `REAL` under `--isolate`.
So `--isolate` is load-bearing for this lane, not a precaution. Prefer, in order:
resolver-level aliasing (T8), substitution through production's own seams, then `mock.module`.

`vitest.setup.ts`'s global `vi.mock('@/lib/auth-client')` did **not** get a mechanical
translation: it is a `tsconfig.test.json` `paths` entry pointing at
`tests/support/setup/auth-client-stub.ts`, whose `setTestSession()` seam replaces the four
per-file re-mocks. `bun.setup.ts` resets it in `afterEach`.

## Parity gate

Every PR on this branch:

```bash
bun run check                 # biome + tsc + knip; green per PR, not just at the end
bun run test                  # all workspaces
bun scripts/test-build.ts     # the ONLY thing that runs the compiled binary
```

`test-build.ts` is non-negotiable here. `check`, `test` and `verify` are all blind to
compiled-binary breakage, and this migration changes exactly what gets embedded into the
binary; its `mode & 0o111` assertion is what catches a non-executable artifact.

Bundle size, for any PR that changes what `dist/` contains:

```bash
bun run --filter @mangostudio/frontend build
bun ./scripts/ci/frontend-bundle-report.ts --baseline scripts/ci/frontend-bundle-baseline.json
```

The baseline is the Vite output captured before the migration started, and it is not
reproducible once Vite is gone. Rows are keyed by hash-stripped chunk name, so a chunk that
merely got a new hash reads as unchanged and a real regression stands out. Report the table in
the PR body; Bun's automatic splitting is accepted, its cost is not accepted silently.

Manual dev smoke, once Elysia serves the bundle — no automation covers this:

- [ ] `bun run dev` serves the app on `:3001`; `:5173` is not listening
- [ ] editing a component hot-reloads without a full page reload (React Fast Refresh)
- [ ] editing a Tailwind class updates without a reload
- [ ] `/api/*` responds; the realtime WebSocket at `/api/ws` connects and survives >2min
- [ ] a deep link (`/settings/agents`) served directly returns the SPA shell, not a 404 (T7b)
- [ ] `/uploads/*` and `/images/*` still resolve
- [ ] browser console errors are echoed to the terminal (`development: { console: true }`)

## Out of scope

Elysia or Eden version bumps; the `apps/api` and `apps/runtime` test lanes and their sharding;
Playwright browser smoke, which drives a built app over HTTP and does not care which bundler
produced it — but confirm the port it targets.
