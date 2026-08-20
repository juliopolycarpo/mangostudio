# Tooling

## Bun

The repo pins Bun **1.4.0**, the release that made the Rust runtime rewrite
generally available. It tracked the `canary` channel for the three months 1.3.14
spent as the newest stable; that is over, and nothing here floats any more.

Install it with `bun upgrade`, or `curl -fsSL https://bun.sh/install | bash` from
cold.

### Two fields name the same toolchain, for two different consumers

| File                            | Value       | Read by                                                    |
| ------------------------------- | ----------- | ---------------------------------------------------------- |
| `.bun-version`                  | `1.4.0`     | `oven-sh/setup-bun` — the build CI actually installs       |
| `package.json` `packageManager` | `bun@1.4.0` | Turborepo only — a floor marker, never what gets installed |

Two consumers, one answer, and they must now agree —
`scripts/tests/bun-toolchain.unit.test.ts` fails if one is bumped without the
other. They were allowed to disagree under `canary` because their requirements
were mutually exclusive there:

- **setup-bun resolves release tags**, and Bun published exactly one canary tag —
  the literal `canary`, rebuilt per commit on main. There was no
  `bun-v1.4.0-canary.1` tag to point at, so the installed build could only be
  named `canary`.
- **Turborepo parses `packageManager` as semver or a URL** and refuses to resolve
  the workspace at all against `bun@canary`. It needs a version-shaped string.

`.bun-version` remains the single source of truth for *which Bun*. Only it is
ever installed; `packageManager` is a floor Turborepo reads and nothing else.

### What the canary period left behind

Two habits are worth keeping, because they cost nothing and a released pin is not
guaranteed to be permanent:

- **Install-cache keys use `bun --revision`, not `bun --version`.** `--version`
  is unique per release and would work today; `--revision` appends the commit
  (`1.4.0+34cbb9a40`) and stays correct for a rebuilt tag or a channel too. A key
  on `--version` was what handed one canary build's extracted packages to a
  different one.
- **The distribution manifest records `bunRevision` alongside `bunVersion`.**
  `Bun.version` reports `1.4.0`; `Bun.revision` names the commit that built it.
  Note the two spellings differ — `bun --revision` prints `1.4.0+34cbb9a40` while
  the JS `Bun.revision` returns the full 40-character sha, and they do not
  compare equal.

One mechanism is now **dormant, not deleted**:
`scripts/lib/bun-cross-runtime.ts`. `bun build --compile` builds a
foreign-platform binary by downloading a prebuilt Bun and resolving it from
`Bun.version`; on canary that asked for the unreleased tag `bun-v1.4.0` and every
non-host target failed. The module fetched the channel asset per target and
passed it to `--compile-executable-path`. Against a released pin
`bunCrossCompileChannel()` returns null, `--compile` resolves
`bun-v1.4.0` itself, and none of that runs. Moving `.bun-version` back to a
channel is the whole switch.

Because it is dormant, the two lanes that verified it are gone — `cross-runtimes`
in `ci.yml` and `cross-runtime-nightly.yml` both existed to catch a stalled
download from a channel that moved daily, and against a pin they spend a runner
to assert nothing. `scripts/ci/verify-cross-runtimes.ts` is kept and still runs
by hand; restoring the lanes, with their five-minute bound, is part of moving
back to a channel rather than a separate change. The bound is the feature there:
the failure mode is a stall, not an assertion.

To bisect a suspected Bun regression, move `.bun-version` and `packageManager`
together to another released tag (`1.3.14`) on a scratch branch — that is all it
takes, and no assertion has to be flipped. Going back to a **channel** does need
two flips in `scripts/tests/bun-toolchain.unit.test.ts`: the two-fields-agree
test, and the one asserting `bunCrossCompileChannel()` is null. They are the
tripwires that say the pin is still in place.

## TypeScript 7

The monorepo type-checks with [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/),
the native Go port. TS 7 ships a single `tsc` binary that parallelizes parsing,
type-checking, and emitting across cores, typically 8–12x faster than TS 6 on
full builds.

### Type-checking

Each workspace runs `tsc --noEmit` (pinned to `7.0.2`) via its `typecheck`
script. Turbo orchestrates these across workspaces in parallel, and each `tsc`
invocation further parallelizes internally — the two layers compose without
conflict.

### Parallelization tuning

TS 7 exposes experimental flags for fine-tuning parallelism:

| Flag               | Default | Purpose                                                                                                           |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `--checkers N`     | 4       | Number of type-checker workers. Increase on machines with more cores; set to 1 on memory-constrained CI runners.  |
| `--builders N`     | 1       | Parallel project-reference builders under `--build`. Not used here — Turbo handles cross-workspace orchestration. |
| `--singleThreaded` | off     | Disables all parallelism. Useful for debugging order-dependent diagnostics.                                       |

The defaults are left in place; the monorepo is small enough that `--checkers 4`
is the sweet spot. If CI runners run low on memory, set `--checkers 2` or
`--checkers 1` in the workspace `typecheck` scripts.

### Compatibility API

TS 7.0 does not expose a stable programmatic API. The QA-gate coverage scripts
(`scripts/qa-gate/source-*-coverage.ts`) import the compiler API from
`@typescript/typescript6` (pinned to `6.0.2`), the official side-by-side
compatibility package. When TS 7.1 ships a new API, the compat dependency can
be removed.

## Turborepo

This monorepo uses [Turborepo](https://turborepo.dev) **2.x** (currently
`2.10.8`) as its shared build-system layer. Turborepo orchestrates task
execution across workspaces and provides a content-addressable cache so that
unchanged work is never rebuilt.

### Policy

- **Stable 2.x only.** The pinned version in the root `package.json` is the
  single source of truth. No canary builds, no floating ranges.
- **No Remote Cache yet.** Local cache only until the task model is proven.
- **Root Bun wrappers are the public interface.** `bun run dev`, `bun run build`,
  `bun run check`, and `bun run test` remain the canonical commands. Turborepo
  is invoked through them or via the `turbo:*` inspection scripts.

### Configuration

The task graph lives in `turbo.jsonc` at the repository root. The `.jsonc`
extension is used so that inline comments can document migration decisions.

Current task definitions:

| Task               | Cache | Outputs / Env                                      | Notes                                        |
| ------------------ | ----- | -------------------------------------------------- | -------------------------------------------- |
| `dev`              | off   | —                                                  | Persistent — runs dev servers                |
| `build`            | on    | `dist/**`; env `VITE_*`                            | Depends on upstream `^build`; restores dist  |
| `check:quick`      | on    | —                                                  | Lint / format; inputs scoped to `biome.json` |
| `typecheck`        | on    | —                                                  | Inputs scoped to root `tsconfig.json`        |
| `circular`         | on    | —                                                  | Circular dependency detection                |
| `test:unit`        | on    | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Unit tests                                   |
| `test:integration` | off   | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Integration tests (always re-run)            |
| `test:coverage`    | off   | `$TURBO_ROOT$/.mango/artifacts/coverage/**`; env ↑ | Coverage reports (always re-run)             |
| `//#test:scripts`  | on    | inputs `$TURBO_DEFAULT$`, `scripts/**`             | Root scripts tests (cached via turbo)        |

### Inspection Scripts

| Script                  | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `bun run turbo:version` | Print the installed Turborepo version         |
| `bun run turbo:dry`     | Dry-run the build graph (JSON output)         |
| `bun run turbo:graph`   | Export the build graph to `.turbo/graph.html` |

### Cache Directory

Turborepo writes its local task-output cache to `.turbo/cache` at the repository
root. This directory is gitignored and should never be committed.

CI persists the local Turbo cache with `actions/cache` in the check, test, and
build lanes. Each lane uses a separate key prefix so the lanes never share a
cache entry — each saves and restores only its own snapshot:

```text
${{ runner.os }}-${{ env.CACHE_VERSION }}-turbo-<lane>-${{ github.sha }}
```

The `github.sha` suffix makes every successful run save a fresh cache, while the
lane restore prefix restores the most recent cache for that lane. Bumping
`CACHE_VERSION` still invalidates all CI caches when a cache-poisoning rollback
is needed.

The CI check lane still keeps its separate `.mango/artifacts/tsbuildinfo/` cache
because shared TypeScript build-info files are deliberately not Turbo task
outputs. Vite optimizer caches also remain separate because they are dependency
optimizer state, not task outputs.

### Future Work

- Remote Cache for CI.
- `--affected` filtering in CI pipelines.
- Package-specific Turbo configuration once the base graph is stable.

## Elysia build-time AOT — evaluated, not adopted

Elysia 2 ships a Bun build plugin (`elysia/plugin/aot/bun`) that moves handler
and validator compilation from process start to build time. It was measured
against MangoStudio on 2026-08-13 and **not adopted**: it is correct here, but
it buys nothing this repository can spend.

### What was measured

Elysia `2.0.0-beta.4`, Bun `1.3.14`, linux-x64, ten runs per figure, each under
a throwaway `HOME` and database. Both binaries were produced by the same
programmatic `Bun.build({ compile })` call from the same source, so the only
variable is the plugin.

| Measure                       |      JIT |      AOT | Delta | Gate        | Result |
| ----------------------------- | -------: | -------: | ----: | ----------- | ------ |
| Cold start → `/api/health`    |   980 ms |  1001 ms | +2.1% | ≥10% gain   | fail   |
| Warm start → `/api/health`    |   898 ms |   907 ms | +1.0% | ≥10% gain   | fail   |
| First schema-backed request   |   196 ms |   193 ms | −2.0% | not slower  | noise  |
| Compile duration (per target) |  1094 ms |  4049 ms | +270% | ≤20% growth | fail   |
| Binary size                   | 111.2 MB | 113.2 MB | +1.8% | ≤5% growth  | pass   |
| Peak RSS during startup       |   152 MB |   157 MB | +2.7% | —           | —      |

Reproduce the startup halves with `scripts/bench/startup.ts` against two
binaries; see `scripts/README.md`.

### Why there is nothing to win

Startup is not spent in Elysia. It goes to migrations, opening SQLite, Better
Auth initialization, and evaluating a ~111 MB bundle. Route compilation is a
small enough slice that removing it entirely stays inside run-to-run noise —
which is also why the AOT binary measured marginally *slower*: it carries a
larger manifest to load.

### What the evaluation did establish

The plugin is not broken here. Both binaries served a byte-identical OpenAPI
document with the same 188 operations, so route and contract parity is not the
objection. Three findings are worth keeping:

- The capture step **imports the app inside the build process**. Anything the
  app does at import time therefore happens during a build — which is how the
  eager `getDb()` defaults in the repository factories were found, and why
  `apps/api/tests/integration/server/app-import-side-effects.integration.test.ts`
  now pins that importing the app opens no database.
- Sealed validators carrying a coercion or codec schema report their 422 field
  detail coarsely. That is 15 routes — across api-keys, environments,
  external-agents, git, library, respond, settings, and tool-identities —
  trading error-message precision for the compile-time win. The plugin only
  says so under `verbose: true`, so adopting it without that flag would ship
  the coarser errors silently.
- `scripts/build.ts` shells out to the `bun build` CLI, which has no plugin
  flag. Adopting AOT means moving binary compilation to programmatic
  `Bun.build({ compile })` for every target — a build-pipeline rewrite that the
  measurements above do not pay for.

Revisit if Elysia's own startup share grows, if migrations and bundle
evaluation stop dominating, or if a target appears (workerd) where runtime JIT
is unavailable rather than merely slower.

## `Bun.Archive` — adopted for reading, rejected for writing

Every archive this repository *reads* is read in-process by `Bun.Archive`
(`scripts/lib/archive.ts`). Every archive it *writes* still shells out to `tar`
or `zip`. The split is not a staged migration: creation cannot convert until
`Bun.Archive` can store a file mode.

### The blocker

`Bun.Archive` writes every entry `0644` and offers no way to say otherwise.
Re-verified on the pinned `1.4.0`: a `mode` passed in the options object or
per-entry is accepted and ignored, and unknown options are accepted silently, so
there is no error to notice. (Per-entry, `{ data, mode }` is worse than ignored —
the object itself gets serialized instead of the blob.) A natively created
platform archive therefore ships a hub binary that will not run:

- `scripts/test-build.ts` fails the build on it directly, asserting `mode & 0o111`
  on both binaries in the extracted archive.
- The Homebrew formula does `libexec.install Dir["*"]` with no chmod, so the
  mode in the tarball is the mode users get. Its own `test do` block would fail.
- `tar -xzf mangostudio-*.tar.gz && ./mangostudio` is a documented install path.
- The npm platform packages are published from an extracted distribution bundle,
  so a `0644` binary inside that bundle reaches the registry.

`scripts/install/install.sh`, `stage-docker-ctx.ts` and `bun-cross-runtime.ts`
all chmod after extracting and would not have noticed.

### What the conversion is worth

Measured 2026-08-20 on this machine against a two-binary, 160 MB payload — the
shape of a real platform archive:

| Operation      |           GNU tar |                                       Bun.Archive |
| -------------- | ----------------: | ------------------------------------------------: |
| create, gzip 6 | 9755 ms → 73.3 MB | 3634 ms → 72.8 MB — *faster and smaller, blocked* |
| create, gzip 1 |                 — |                                 2313 ms → 77.3 MB |
| extract        |   1352 ms–1419 ms |                                     617 ms–993 ms |
| list           |           1299 ms |                                           1203 ms |

So the adopted half is worth roughly 1.8× on extraction, and the rejected half —
the larger prize, 2.7× on creation *with* a smaller artifact — stays on the
table until upstream stores modes.

### Other limits found while probing

All verified against the Bun the repository pins, not inherited from docs:

- **gzip and stored tar, both directions.** `.tar.xz` and `.tar.bz2` throw
  `Unrecognized archive format` where GNU tar auto-detects them. Zip is not
  readable at all, so the Windows targets and the Bun cross-runtime download keep
  their `unzip`/PowerShell/bsdtar subprocesses. Stored tar is detected from the
  bytes rather than the name, which is what lets the target distribution
  bundles ship uncompressed. See
  [`releasing.md`](./releasing.md#distribution-bundle-compression).
- `files()` is an async method returning `Promise<Map<string, File>>`, and it
  **omits symlink and directory entries**. Anything guarding on that listing sees
  fewer entries than `tar -tzf` reports.
- `extract()` does preserve modes and, on POSIX, in-tree symlinks. It silently
  strips leading `..` segments and drops symlinks pointing outside the
  destination. On Windows it skips every symlink regardless of privilege
  (upstream's documented extract contract). Safety guards still run first,
  because silent sanitization in a release lane is worse than a named error.
- Passing a lazy `Bun.file()` handle as an entry value writes a **0-byte entry**
  with no error, and passing one to the constructor throws
  `Unrecognized archive format`. Read the bytes first.
- The extension is ignored: `Bun.Archive.write('x.tar.gz', files)` with no
  `compress` option writes an uncompressed tar named `.tar.gz`.

Revisit when `Bun.Archive` gains a mode option; `archive-assets.ts` and
`bundle-distribution.ts` carry the pointer at their creation functions. Upstream
tracks it as [oven-sh/bun#33212](https://github.com/oven-sh/bun/issues/33212),
with an unmerged PR at
[#33213](https://github.com/oven-sh/bun/pull/33213) — check whether that landed
before re-probing the option parser.
