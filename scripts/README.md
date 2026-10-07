# scripts/

Bun-native automation for the monorepo. Every script runs under `bun` (no
node/tsx/ts-node) and is invoked from the repo root, usually via a `package.json`
script (`bun run <name>`).

## Layout

```
scripts/
├── dev.ts            Start dev servers (bun run dev)
├── build.ts          Build workspaces or standalone binaries (bun run build)
├── build-runtime.ts  Build the cargo mangostudio-runtime per release target (bun run build:runtime)
├── check.ts          Biome lint/format + import cycles + dprint + tsc + workflow static analysis, in parallel (bun run check)
├── check-import-cycles.ts
│                     Cycle-only TS/TSX scan, including generated and gitignored files
├── check-versions.ts Assert application + launcher versions agree (bun run check:versions)
├── update-node-release-schedule.ts
│                     Refresh bundled Node lifecycle and latest-patch data
├── fix.ts            Apply Biome + dprint fixes (bun run fix)
├── test.ts           Run unit/integration/e2e/coverage lanes, whole, sharded, or --changed (bun run test)
├── verify.ts         check → test → build gate (bun run verify)
├── clean.ts          Remove build artifacts (bun run clean)
├── changelog.ts      git-cliff wrapper: init/preview/release (bun run changelog)
├── bench/            Hermetic performance measurement (startup.ts, runtime-handshake.ts, grep.ts, library-walk.ts + its fixture plans)
├── ci/               Dependency-free workflow steps (gate evaluation, distribution identity, cross-runtime fetch, test-shard and timings merge, Rust lane relevance and qualification selection)
├── lib/              Shared toolkit (see below)
├── examples/         Runnable maintainer samples (dependency-free Bun scripts)
├── install/          Canonical installers (install.sh, install.ps1): shipped as release assets on both channels and embedded in the hub binary
├── qa-gate/          PR metrics collector, comment renderers + comment publisher
├── release/          Release-time packaging + publication (see below)
├── runtime-contract/ Emit + drift-check the cross-language hub/runtime artifacts (bun run contracts:emit)
└── tests/            Cross-cutting unit tests (co-located tests live beside sources)
```

## lib/ — shared toolkit

`lib/runner.ts` is a barrel re-exporting focused, single-concern modules — prefer
importing the specific module in new code:

| Module                 | Concern                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `log.ts`               | Leveled console output + ANSI colors                                                                     |
| `args.ts`              | CLI argument + workspace-selection parsing                                                               |
| `git.ts`               | Change detection (`Bun.spawnSync`), workspace mapping                                                    |
| `exec.ts`              | `runCommand`, `captureCommand`, `mapWithConcurrency`, `archiveConcurrency`, `runParallel`, `runTask`     |
| `summary.ts`           | Pass/fail reporting + exit handling                                                                      |
| `fs.ts`                | Cross-platform `removePaths` (no spawned `rm`)                                                           |
| `fs-assert.ts`         | `assertFile`/`assertDirectory` (throw) + `fileError` (collect)                                           |
| `config.ts`            | Workspace definitions + root lint/format path lists                                                      |
| `import-cycles.ts`     | Shared cycle-only Biome command for required workspace checks and QA                                     |
| `changelog.ts`         | git-cliff arg/format logic (wrapped behind a project API)                                                |
| `npm-pack.ts`          | npm distribution manifest builders                                                                       |
| `release-version.ts`   | Canonical release version resolver + lockstep consistency check                                          |
| `prepare-release.ts`   | Two-phase lockstep version bump for release preparation                                                  |
| `bun-cross-runtime.ts` | Per-target Bun runtime for `--compile` when `.bun-version` names a channel (dormant on a released pin)   |
| `runtime-build.ts`     | Cargo runtime per release target: triple map, glibc floor, prebuilt-dir resolution, staged-binary checks |
| `executable-header.ts` | ELF / Mach-O / PE header reader: format, CPU, ELF interpreter, highest `GLIBC_` version                  |
| `actions-lint/`        | Pinned workflow static analysis: manifest, bootstrap, tasks                                              |

Workspace `check:quick` scripts run normal Biome checks followed by
`check-import-cycles.ts`. The cycle pass uses the independent
`biome.cycles.json`, so formatting exclusions and `.gitignore` cannot hide TS/TSX
cycles. It includes declarations and generated/build files, excludes only
`node_modules` and `.git`, and raises the file-size limit to JavaScript's largest
safe integer instead of inheriting Biome's one-MiB limit. Turbo always reruns
`check:quick` because ignored files are absent from its VCS cache inputs.

Run one scan from the repository root with
`bun scripts/check-import-cycles.ts apps/api`.

## The runtime binary: cargo, not Bun

`bun run build --binary` compiles only the hub with Bun. The
`mangostudio-runtime[.exe]` beside it is the cargo binary from
`crates/mangostudio-runtime`, and comes from one of two places:

- `--runtime-dir <dir>` (or `RUNTIME_DIR`): a directory laid out as
  `<dir>/<platform-id>/mangostudio-runtime[.exe]`, authoritative for every
  requested target. CI fills it from `.github/workflows/runtime-build.yml`.
- Otherwise, the host's own target only, via
  `cargo build --release --locked -p mangostudio-runtime --target <triple>`.

Any other target without a prebuilt file fails before anything compiles,
naming the file it expected. `bun run build:runtime` produces that layout:

```bash
bun run build:runtime --platform linux-arm64,linux-x64-musl --zig --out .mango/runtime-prebuilt
bun run build --binary --platform linux-arm64 --runtime-dir .mango/runtime-prebuilt
```

`--zig` links Linux targets through cargo-zigbuild (zig and cargo-zigbuild on
`PATH`): gnu at the `GLIBC_2.17` floor, musl static. `--rustup` installs each
target's standard library first. Both paths stamp the release version in at
compile time (`MANGOSTUDIO_RELEASE_VERSION`) — or `dev` with `--dev`, the version a
source checkout's hub accepts — and check each binary's header —
and its `--version`, when this machine can run it — before it is staged.
`docs/reference/releasing.md` records the per-target toolchains and the floor.

## actions-lint/ — workflow static analysis

`bun run check` runs three pinned binaries against the repository's automation
surface, as does CI's Check job (same script):

- **actionlint** over `.github/workflows/**`, with ShellCheck applied to
  embedded `run:` scripts;
- **zizmor** over `.github/` (workflows + composite actions) in blocking
  `--persona pedantic --min-confidence high` mode (offline audits only);
- **ShellCheck** over every tracked `*.sh` file.

`lib/actions-lint/manifest.ts` pins each tool's version, per-platform release
asset, and SHA-256. `lib/actions-lint/bootstrap.ts` downloads the archive,
verifies the checksum, rejects unsafe archive entry paths, and caches the
binary under the ignored `.mango/artifacts/tools/`; nothing unverified is ever
executed, and a populated cache works offline. Scoped runs (`--staged` /
`--changed`) trigger the lane only when `.github/**`, `*.sh`, or
`scripts/lib/actions-lint/**` changed — and then always repository-wide.

Dependabot cannot bump these pins. To update a tool: bump `version`, the asset
names, and the SHA-256s in `manifest.ts` in one commit, taking checksums from
the upstream release (`actionlint_<version>_checksums.txt` for actionlint;
`sha256sum` over the downloaded archives for zizmor/ShellCheck). The unit
tests and CI cache key (`lint.yml`) follow the manifest automatically.

Suppressions policy: fix findings at the source. When a finding is truly
unavoidable, suppress it at the narrowest scope (inline
`# zizmor: ignore[rule]` / `# shellcheck disable=SCnnnn`) with rule ID and
reason — never a global ignore.

## qa-gate/ — PR QA report automation

Powers the two QA bot comments on every PR: QA metrics, and commits plus
changelog preview. Collection runs
unprivileged inside CI (`ci.yml`); publishing runs in the trusted
`pr-qa-report.yml` workflow with default-branch tooling only:

- `collect-test-metrics.ts` — emit the test fragment (suite outcome, duration,
  failure counts and error headlines, coverage summaries) in the Test workflow's
  merge job, from the JUnit reports and coverage the eight shards produced.
- `junit-results.ts` — parse `<testcase>` outcomes out of a JUnit report and say
  whether the report is demonstrably whole. Replaced 269 lines of runner-log
  regex.
- `results/` — fold each lane's reports and process receipts across the expected
  job set into one measurement per lane: `partial` for a lost, cut-off or
  timed-out job, `unavailable` for nothing readable, retries deduplicated by
  test identity. See `docs/reference/testing.md`.
- `policy/` — the verdict as a pure function (`pass` / `fail` / `incomplete`)
  with a truth-table test; `render/verdict.ts` only words it.
- `unhandled-errors.ts` — the one signal JUnit cannot carry, for either runner:
  Vitest's reporter never receives the run's unhandled errors, and Bun's
  between-tests block never reaches its report either. Each shard extracts both
  from its own log.
- `merge-lcov-shards.ts` — merge per-shard Bun LCOV. Not a concatenation and not
  a union; see `docs/reference/testing.md` for why the naive merge reports a
  coverage regression that did not happen. Order-independent, and it fails
  naming the shard when a report is missing, empty or truncated.
- `../ci/merge-timings-shards.ts` — reassemble the per-shard `--timings` slices
  that balance the next run's split, and fail the run if two shards claimed the
  same file. That is the observable symptom of shards reading different timings,
  which means they did not cover the suite between them while all exiting 0.
- `collect/circular.ts` — count Biome cycle witnesses across the discovered JS
  workspaces and `scripts/`, using the same independent TS/TSX scope and command
  as required workspace checks, including type-only and self imports. A complete
  JSON scan returns zero directly when clean. For cycles, the text reporter
  supplies closed paths that are matched to every JSON diagnostic, split at
  repeated files and deduplicated by rotation. This counts reported cycles,
  not individual imports; overlapping graphs can differ from the former
  madge DFS count. Skipped files, truncated output, other errors or a reporter
  format change make the metric unavailable.
- `collect.ts` + `collect/*` — discover the repository's components and merge
  the test fragment with per-component static LoC, coverage and type-check
  results plus bundle, dependency, duplication, and tooling metrics into the v4
  `qa-metrics` envelope (`metrics-envelope.ts`), uploaded for PR heads and main
  baselines. In CI, bundle stats measure the frontend `dist` artifact from the
  Build job (`QA_FRONTEND_DIST`); local runs build the frontend when that env
  var is unset. Provenance (`sourceSha`, producer, run id and attempt) comes from
  `GITHUB_SHA`, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`; a local run gets
  placeholder run identity, a CI run with a missing value fails.
  - `collect/registry.ts` — the component registry: `package.json` workspaces,
    `Cargo.toml` `[workspace].members` (parsed, not `cargo metadata`: the
    pinned `rust-toolchain.toml` makes a rustup-proxied cargo download a
    toolchain in a Bun-only lane) and the `scripts/` mapping. Ownership is
    longest-root-prefix, so nested roots count once (the excluded
    `crates/mango-protocol/fuzz` workspace belongs to `mango-protocol`). A tracked
    file no component owns, and is not in `NON_COMPONENT_DIRECTORIES`, fails
    integrity: a new top-level directory is an error to fix, never files dropped
    from the totals.
  - `rust-coverage/*` — per-crate Rust coverage from the CI Rust coverage job's
    artifact (`--rust-coverage <dir>`: the `cargo llvm-cov` export plus a receipt
    naming the commit and the test exit code). `inputs.ts` decides the state
    before reading anything (`QA_RUST_RELEVANT` false is `unsupported`, a due job
    that delivered nothing is `unavailable`); `resolve.ts` attributes each file to
    the crate whose root owns it. A crate with no profile data or 0 executed
    lines is `unavailable`, a non-zero test exit is `partial`, another commit is
    `stale`; none is ever a zero.
  - `collect/loc.ts` — static LoC per component and class (production, test,
    generated, fixture, config, docs). An unreadable file makes the component
    `partial` with the path as the reason; it never lowers a total silently.
- `model/*` — the schema-first v4 model (TypeBox, types derived with `Static<>`).
  Every measurement is a `Measurement<T>` in one of five explicit states:
  `measured`, `partial` (lower bound plus reasons), `stale`, `unavailable` and
  `unsupported` (no value: never a zero, never a success). A zero denominator is
  `pct: null` (n/a). Future PRs extend `Component` with more measurements
  (per-file function coverage).
- `metrics-envelope.ts` — schema version, parse/validate for untrusted artifacts
  (size cap, shape, consistency, repository/SHA/PR match) and the serializer the
  collector emits through. An envelope of another schema version (v3 and older
  are historical) throws `IncomparableEnvelopeError`: it is never read and never
  produces a delta.
- `load-metrics.ts` — loads one artifact for the renderer; a v3 baseline reads as
  incomparable rather than as an unavailable baseline.
- `render-report.ts` + `report-document.ts` + `render/*` + `commit-log.ts` —
  render the two comments (`--part metrics|commits`, one process each so a
  failure in one never blocks the other): the QA comparison (verdict headline,
  summary deltas, collapsed metric tables), and the commit summary plus
  changelog preview (each list expanded up to 5 items, folded above).
- `publish/report-pipeline.mjs` — trusted-side input resolution (open-PR
  lookup by exact head SHA, size-capped artifact downloads, exact-base
  baseline run lookup keyed by the base SHA the head envelope recorded at CI
  time, accepting any completed non-cancelled main run). Plain ESM so
  `actions/github-script` imports it.
- `publish/metrics-archive.mjs` — bounded in-memory reads of a qa-metrics
  archive: the head's recorded `baseSha` (only a 40-hex SHA is accepted) and
  whether a main baseline is complete (schema v4, exact SHA, every metric
  `measured` or `unsupported`; an `unavailable`, `partial` or `stale` metric makes
  it partial). Another schema version is reported as incomparable, not as a
  missing baseline. Anything else makes the baseline unavailable.
- `publish/managed-comments.mjs` — publisher that updates each comment in
  place by its own marker (update-or-create), removes duplicates per marker,
  deletes legacy comments (the retired combined report included) only after
  both replacements are written, and skips publishing when the PR head has
  moved on.

## release/ — release-time packaging + publication

Run by `.github/workflows/release.yml`; each is also runnable locally:

| Script                     | Concern                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare-release.ts`       | Stage a release: lockstep bump + changelog + self-check (`bun run release:prepare`)                                                                                        |
| `archive-assets.ts`        | Assemble `release-assets/` (platform archives, installers, `SHA256SUMS`)                                                                                                   |
| `bundle-distribution.ts`   | Create content-addressed scoped (checksums, assets, npm) and per-target distribution bundles                                                                               |
| `distribution-manifest.ts` | Record and verify distribution identity, file sizes, and SHA-256 checksums                                                                                                 |
| `extract-distribution.ts`  | Reject unsafe bundle paths, then extract a downloaded distribution                                                                                                         |
| `extract-target.ts`        | Safely materialize `.mango/out/<target>` from a verified target archive                                                                                                    |
| `stage-docker-ctx.ts`      | Stage Linux glibc/musl binaries into `docker-ctx/` for Docker Buildx                                                                                                       |
| `pack-npm.ts`              | Stage `.mango/out/<arch>` binaries into the npm distribution                                                                                                               |
| `publish-npm.ts`           | Idempotent npm publication with retry + required provenance policy (`--tag`, `--provenance-policy`)                                                                        |
| `verify-checksum.ts`       | Check one downloaded asset against `SHA256SUMS`                                                                                                                            |
| `template-renderer.ts`     | Shared renderer: fill `{{VERSION}}`/`{{SHA_*}}` from `SHA256SUMS`                                                                                                          |
| `update-homebrew.ts`       | Render `Formula/mangostudio.rb` from `SHA256SUMS` + `templates/`                                                                                                           |
| `update-scoop.ts`          | Render `bucket/mangostudio.json` from `SHA256SUMS` + `templates/`                                                                                                          |
| `push-dist-repo.ts`        | Push changed files into an external dist repo (tap/bucket), idempotently                                                                                                   |
| `publish-summary.sh`       | Render a per-channel ✅/❌ publish table into the GitHub step summary                                                                                                      |
| `retry.sh`                 | `retry_command` helper sourced by workflow shell steps                                                                                                                     |
| `publish-release.sh`       | `publish_release` helper: one `gh release create` (draft → upload → publish); never edits or uploads onto an already-published release, since immutable releases forbid it |
| `prune-canary-releases.ts` | Delete old per-commit canary pre-releases and their tags, keeping the newest few (`--keep`, default 14), plus every leftover canary draft                                  |

## examples/ — maintainer samples

Runnable Bun scripts for manual verification (no extra dependencies):

| Script                  | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `external-api-smoke.ts` | Probe `/api/health` and an authenticated GET with `MANGO_API_KEY` |

```bash
MANGO_API_KEY='mango_…' bun run scripts/examples/external-api-smoke.ts http://localhost:3001
```

## bench/ — hermetic performance measurement

| Script                       | Purpose                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `startup.ts`                 | Median process-start → first healthy `GET /api/health` of a binary                                                              |
| `runtime-handshake.ts`       | Runtime child over stdio: process start → `hello` → first request, min/median/p95/max                                           |
| `grep.ts`                    | Runtime `fs.grep` over stdio: 1/100/1000 small files, a large file, peak RSS, cancel                                            |
| `rust-test-inventory.ts`     | Rust test inventory (libtest or nextest) by logical identity; diff two, total a log                                             |
| `external-agent-boundary.ts` | Actual receipt hashing, admitted request ownership and event mapping; alternating Base/Head processes, raw timings and peak RSS |

`external-agent-boundary.ts` runs ignored Rust libtests, so benchmarks are not part of the normal
test gate. Build each revision's runtime libtest with `cargo test -p mangostudio-runtime --lib
--release --locked --no-run --message-format=json` and `MANGOSTUDIO_BENCH_SOURCE_SHA` set to that
revision's full commit SHA. Set `CARGO_PROFILE_RELEASE_LTO=false` and
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` identically on both builds. This keeps optimization at
level 3 without optimizing the entire test suite under the shipped binary's fat LTO settings.
Cargo's `compiler-artifact.executable` identifies the binary. Then:

```bash
bun scripts/bench/external-agent-boundary.ts --base-binary /path/base-libtest \
  --head-binary /path/head-libtest --base-sha BASE_FULL_SHA --head-sha HEAD_FULL_SHA \
  --samples 30 --profile 'release, opt-level=3, lto=false, codegen-units=16' \
  --output boundary-receipt.json
```

The receipt binds binary hashes and lockfile hashes to both revisions. Fixtures are built before
timing. Linux RSS is the fresh process high-water mark, including those untimed fixtures; unsupported
memory measurements stay null. These are function measurements, not vendor throughput or chat latency.
Keep the same instrumentation on both revisions and stop competing builds during timing.

```bash
bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio --runs 10
bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio --warm
```

The startup benchmark gives each run a temp `HOME`, database, uploads, and images directory, so the
developer's real `~/.mango` is never read or written. Cold (default) measures a
first run with every migration applying; `--warm` migrates once, discards that
run, and measures the restart cost — the only mode where framework and
module-load time are visible rather than buried under migration work.

Compare two binaries by building both and running the same command against
each; a startup claim is only worth as much as its median and spread.

`runtime-handshake.ts` spawns `mangostudio-runtime --stdio` through the protocol SDK's
launcher, exchanges `hello` as the hub does and asks for `runtime.health`, with a fresh
`MANGO_HOME` per run. It defaults to the newest `target/` build; `--fresh-copy` runs a new
copy of the binary each time, which on Windows puts the antivirus and loader's first look at a
file into every sample. The numbers it produced are recorded under "Runtime startup budgets" in
`docs/reference/tooling.md`.

```bash
bun run scripts/bench/runtime-handshake.ts target/release/mangostudio-runtime --runs 30
bun run scripts/bench/runtime-handshake.ts target/release/mangostudio-runtime --fresh-copy
```

`grep.ts` drives `fs.grep` on the real runtime binary, one fresh child (and `MANGO_HOME`) per
sample so peak RSS (`VmHWM`, Linux) belongs to that scenario alone. Each sample times only the
request. `cancel` aborts a catastrophic match after 200 ms and reports the abort-to-answer
latency. Run the same command on a base and a head binary on a quiet machine to compare them.

```bash
bun run scripts/bench/grep.ts target/release/mangostudio-runtime --runs 15
bun run scripts/bench/grep.ts <binary> --scenario files-1000,cancel --json
```

`rust-test-inventory.ts` proves a Rust test-target consolidation or a runner change lost no case:
`capture` (libtest) and `capture-nextest` write every case keyed `<package>/<kind>/<binary>::<test>`,
folding the modules of a consolidated `tests/it/main.rs` back under their former binary names, and
`compare` exits 1 on a missing, added, or re-flagged (`#[ignore]`) case. `summarize` totals a
libtest log's `test result:` lines.

```bash
bun run scripts/bench/rust-test-inventory.ts capture before.json
bun run scripts/bench/rust-test-inventory.ts compare before.json after.json
```

## runtime-contract/ — the boundary as files

A runtime that is not a TypeScript module still has to be fully described by files the hub owns.
Six of them are generated from `RUNTIME_CONTRACT` and committed under
`apps/shared/src/runtime-contract/generated/`.

```bash
bun run contracts:emit    # regenerate
bun run contracts:check   # diff instead of writing (what `bun run check` runs)
```

| Artifact                     | What it describes                                                            |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `catalog.json`               | Every method, its params/result schemas, capabilities, events and manifest   |
| `runtime-home.schema.json`   | `runtime.json`, `credentials.json`, one line of `audit.log`                  |
| `manifest.schema.json`       | `hello.capabilities`, plus the hub identity announced back                   |
| `health.schema.json`         | `health --json` and the `runtime.health` result                              |
| `install-output.schema.json` | One frame of an install run's output stream                                  |
| `strings.json`               | What nothing derives: stderr signature, exit code, token prefix, slot layout |

It needs no third-party binary and no network, so it runs
inside `bun run check` rather than in a workflow of its own — including on a scoped `--staged` run,
because a method's schemas reach most of `apps/shared/src` and an edit two modules away can leave
the catalog stale.

`catalog.json` is validated against the protocol's published
[`catalog.json`](https://mangostudio.dev/protocol/schema/1/catalog.json) on every run of either
mode, with ajv: a wrong catalog is byte-stable too, so a diff check alone would never see it.
Nothing under `generated/` is formatted by Biome.

## Conventions

- **Bun-native.** Use `Bun.spawn`/`Bun.spawnSync`/`Bun.file`/`node:fs` over shelling
  out. Pass command arguments as arrays, never interpolated shell strings.
- **Short, single-concern files.** Split anything large by responsibility, as
  `qa-gate/collect/*` and `qa-gate/render/*` do.
- **Every helper gets a test.** Put cross-cutting tests in `tests/`; tests that pin
  one module may sit beside it (`*.unit.test.ts`). All are picked up by `bun test scripts`.
- **Wrap third-party tools** behind a project-owned module (see `lib/changelog.ts`
  around git-cliff) so the integration is testable and swappable.

## Code health scan

`bun run check` runs Knip as a blocking repository-wide task. Use
`bun run code-health` for the standalone unused code and dependency report.
Register runtime-loaded files as narrow workspace entries in `knip.json`; dependency
ignores require execution evidence documented in `docs/reference/testing.md`.

## Adding a script

1. Create `scripts/<name>.ts`; import helpers from `lib/`.
2. Add `"<name>": "bun ./scripts/<name>.ts"` to the root `package.json`.
3. Add a unit test under `scripts/tests/` for any non-trivial logic.
4. Run `bun run check && bun test scripts`.

## Changelog & releases

`bun run changelog` wraps [git-cliff](https://git-cliff.org) (config: `cliff.toml`):

- `--init [version]` — regenerate `CHANGELOG.md` from full history (default tag: the root `package.json` version)
- `--preview [--base <ref>]` — print the current branch's entries (used by the PR bot)
- `--release <version>` — regenerate `CHANGELOG.md` including `<version>`

The release version (build, npm packaging, and changelog) resolves through
`lib/release-version.ts`: the root `package.json` version, overridable by the
`VERSION` env var, validated as semver. `bun run check:versions` keeps the root,
workspace, `crates/mangostudio-launcher/Cargo.toml`, and its root `Cargo.lock` entry in
lockstep; with `--expect <version>` it also requires `CHANGELOG.md` to carry the
`<version>` release section (the release workflow's pre-build gate).

`bun run release:prepare <version>` stages a release in one command: it bumps
every lockstep manifest (`lib/prepare-release.ts`), regenerates `CHANGELOG.md`
via `changelog --release`, and re-runs `check:versions --expect` as a
self-check. Committing and tagging stay manual.

`scripts/release/pack-npm.ts` turns `.mango/out/<arch>` binaries into the npm
distribution. See `docs/reference/releasing.md` for the full release flow.
