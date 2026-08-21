---
name: bun-frontend
description: Facts, recipes and the parity gate for replacing Vite/Vitest in apps/frontend with the Bun toolchain. Read this before writing OR reviewing any change to the frontend bundler, dev server, or test harness — vite.config.ts, vitest.config.ts, Bun.build(), bunfig.toml preloads, happy-dom setup, migrating a test off vitest, how the API serves dist/, or a diff on the refactor/bun-frontend branch. Carries the measured traps (publicPath, mock.module leakage, the fd leak, dist/ layout) that a plausible-looking change silently breaks.
---

# Bun frontend migration

`apps/frontend` is moving off Vite and Vitest onto one bundler (Bun), one test runner
(`bun test` + happy-dom) and one server (Elysia) in dev and in the shipped binary. Work lands
on `refactor/bun-frontend`; child PRs target that branch, not `main`.

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

## Test migration mechanics

| Vitest                        | `bun test`                                           |
| ----------------------------- | ---------------------------------------------------- |
| `import { vi } from 'vitest'` | `import { jest, mock } from 'bun:test'`              |
| `vi.fn()` / `vi.spyOn`        | `jest.fn()` / `spyOn` from `bun:test`                |
| `vi.mock('@/x', factory)`     | `mock.module('@/x', factory)` — see the leak warning |
| `vi.useFakeTimers()`          | `jest.useFakeTimers()`                               |
| `resolve.alias`               | `tsconfig.json` `paths` (T8)                         |
| `globals: true`               | explicit imports from `bun:test`                     |
| `environment: 'jsdom'`        | happy-dom via the two-file preload (T6)              |
| `setupFiles`                  | `bunfig.toml` `[test] preload`                       |

**`mock.module` is not undone by `mock.restore()`.** `bun test` shares one module graph across
files, so a leftover module mock breaks *other* files — measured in this repo at 8 failures in
4 unrelated suites from one new file. Re-mocking with the real namespace does not fully recover
module-level state either. Prefer, in order: resolver-level aliasing (T8), substitution through
production's own seams, then `mock.module` as a last resort. `--isolate` mitigates this; it
does not license it.

`apps/frontend/tests/support/setup/vitest.setup.ts` carries a *global* `vi.mock('@/lib/auth-client')`.
That one needs a non-`mock.module` home before the bulk migration, not a mechanical translation.

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
