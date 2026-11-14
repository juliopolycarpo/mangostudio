# Continuous Integration

How MangoStudio gates merges on `main`, and which GitHub checks are safe to require in
repository rules.

## Aggregate gates

Each gated workflow has one authoritative aggregate with job ID `gate-unique`.
It declares every mandatory lane in `needs`, runs with `if: always()` and evaluates
dependency results through `scripts/ci/evaluate-gate.ts`.

| Workflow                                                | Required API context on PRs              | Accepted skips                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI` (`ci.yml`)                                         | `CI Gate`                                | Distribution, binary smoke and container smoke only when distribution relevance is exactly `false`; Rust coverage only when Rust relevance is exactly `false`; QA on manual dispatch; the PR-only release dry run on non-PR events |
| `Cargo Shim` (`cargo-shim.yml`)                         | `Cargo Shim Gate`                        | Each Rust lane only under its own path-relevance proof                                                                                                                                                                             |
| `Protocol CI` (`protocol-ci.yml`)                       | `Protocol Gate`                          | Mandatory protocol lanes only when no compiled protocol validation is required                                                                                                                                                     |
| `Release Dry Run` (`release-dry-run.yml`), called by CI | `Release Dry Run / Release Dry Run Gate` | Irrelevant assertion lanes and the clean runtime producer on the verified same-run PR reuse path                                                                                                                                   |

Reusable workflow calls prefix the leaf job name with the caller's job name.
Standalone scheduled or manual Release Dry Run runs report `Release Dry Run Gate`.
The legacy jobs named `Gate` have been removed. The
[required-check snapshot](#branch-protection--required-checks) records the unique
contexts enforced by the main ruleset. Canary independently verifies successful
CI and relevant sibling workflows through their unique aggregate names.

## Preflight

`ci.yml`'s `changes` job is displayed as `Preflight`. It is the one job at the
start of a run that every later lane can depend on, so tiny decisions fold into
it instead of costing a runner slot and a queue wait each (the account runs under
a concurrency cap). It classifies the diff (`distribution`, `rust`) and resolves
the distribution identity from `scripts/ci/distribution-identity.ts`: `version`,
`channel`, `cargo_version` and `source_sha` (the checked out `HEAD`; its
`fetch-depth: 0` adds history, not a different commit). `distribution`, `build`,
`release-dry-run`, both smoke lanes and the cache seed read the identity from
`needs.changes.outputs`.

It also restores the test timings baseline once and uploads it as
`test-timings-baseline-<run_attempt>` (30 days), then passes the name to
`test.yml` as the required `timings_artifact` input. The shard and frontend jobs
download it with no intra-workflow `needs`, so they queue as soon as the
`Local Runtime` build finishes instead of waiting on a separate resolver job. A
miss records `cold` in `source-key.txt` for every consumer. The validity segment
`test-shard-<SHARD_COUNT>` is the one main's merge job saves under, so the
`SHARD_COUNT` in `ci.yml`'s `changes` job must equal the one in `test.yml`
(`timings-cache-writes.unit.test.ts` pins this). A failed-job rerun does not
re-run `changes`, so it keeps the attempt-1 artifact name and the same file
partition; "Re-run all jobs" restores again and uploads the `-2` snapshot.

Distribution skips use an allowlist in [`scripts/lib/ci-lanes.ts`](../../scripts/lib/ci-lanes.ts),
not a broad rule that every Markdown change is irrelevant. On PRs, CI's `changes` job
collects a validated, nonempty diff with both sides of renames and emits
`distribution=false` only if every path is allowlisted. That proof permits the
`distribution`, `smoke` (binary) and `smoke-container` jobs to skip. Unknown paths run them;
pushes and manual dispatches also run them. Rust and protocol relevance are independent.
The gate rejects missing relevance outputs, failures, cancellations and unexpected skips.

Unit tests in `scripts/tests/ci-gate.unit.test.ts` derive each gate's expected `needs` from
the workflow text. `gate-compatibility.unit.test.ts` verifies the surviving unique
producers, mandatory dependencies and accepted-skip contracts. Adding a mandatory
lane without wiring it into the aggregate fails validation.

## Protocol relevance and advisory semver

Protocol CI exempts only the seven classified prose guides in `docs/protocol/`
from compiled validation. Spec files, fixtures, contribution policy, unknown
protocol paths and protocol tooling changes remain relevant. This predicate is
separate from protocol ownership and local contribution checks; a new guide
requires explicit classification. Pull requests and main pushes use the changed
paths; manual dispatch runs the complete workflow.

CI Check owns the Protocol TypeScript check on PRs and main pushes. Protocol CI
retains its TypeScript tests and published-package verification, and runs the
TypeScript check itself on standalone dispatch. Its per-change
`cargo-semver-checks (informational)` job is advisory, including setup failures,
and is excluded from `Protocol Gate` dependencies. Feature powerset, interop,
schema equality and package validation remain mandatory when relevant.

## Minimum supported Rust

All stable Rust crates share the intentional Rust 1.99.0 minimum. This replaces the workspace's
stable-minus-two floor of 1.97.0 and the published launcher's 1.96.0 exception. Every stable member
inherits `[workspace.package].rust-version` from the root `Cargo.toml`, and `rust-toolchain.toml`
pins the same compiler. Policy tests enforce that equality. Application and protocol package
versions still move independently. See [Rust support and releases](./releasing.md#rust-support-and-releases)
for the consumer migration.

Cargo Shim checks the minimum through its native workspace jobs. The table maps every check from
the removed jobs to its replacement at 1.99.0. Default-feature checks stay separate from
all-feature checks, and launcher-only commands keep the launcher's own dependency feature graph.

| Before                   | Command and package/feature scope                                                                                                                                                                              | Target and runner before                                                                            | Replacement at 1.99.0                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --locked`: workspace libraries/binaries, default features                                                                                                                             | Linux x64, `ubuntu-latest`                                                                          | `workspace` on Linux x64, macOS arm64 and Windows x64, `cargo build --workspace --locked`                                                  |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --all-targets --all-features --locked`: workspace, every target kind and feature                                                                                                      | Linux x64, `ubuntu-latest`                                                                          | `workspace` on Linux x64, macOS arm64 and Windows x64, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`     |
| `target-msrv`, 1.97.0    | `cargo check --workspace --all-targets --all-features --locked --target <t>`: full workspace                                                                                                                   | `aarch64-apple-darwin` on `macos-latest`; `x86_64-pc-windows-msvc` on `windows-latest`, both native | `workspace`, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` on each native runner through its host target |
| `target-msrv`, 1.97.0    | Same full-workspace check, `--target aarch64-pc-windows-msvc`                                                                                                                                                  | Windows ARM64 cross-check from x64 `windows-latest`                                                 | `workspace-windows-arm64` on native `windows-11-arm`, same command and explicit target                                                     |
| `target-msrv`, 1.96.0    | `cargo check -p mangostudio --all-targets --locked --target <t>`: launcher alone, default features                                                                                                             | Native macOS arm64 and Windows x64                                                                  | `workspace` on those runners, `cargo check -p mangostudio --all-targets --locked`; also runs on Linux x64                                  |
| `target-msrv`, 1.96.0    | Same launcher-only check, `--target aarch64-pc-windows-msvc`                                                                                                                                                   | Windows ARM64 cross-check from x64 `windows-latest`                                                 | `workspace-windows-arm64` on native `windows-11-arm`, same command and explicit target                                                     |
| `launcher-msrv`, 1.96.0  | `cargo check -p mangostudio --all-targets --locked`, `cargo clippy -p mangostudio --all-targets --locked -- -D warnings`, `cargo test -p mangostudio --all-targets --locked`: launcher alone, default features | Linux x64, `ubuntu-latest`                                                                          | Ubuntu `workspace` retains all three commands; launcher checks also run on macOS arm64 and Windows x64                                     |

Every row uses the same `RUST_WORKSPACE_PATHS` signal in `scripts/lib/rust-lanes.ts` before and
after the move, and feeds `Cargo Shim Gate`. `crates/**` selects runtime-only changes, and
`spec/**` and the other inputs the crates read select protocol changes. Pull requests without a
matching Rust path skip the Rust jobs under the gate's relevance proof; the gate still reports.
Pushes selected by the workflow filter and manual dispatches run the Rust jobs. Protocol CI keeps
its own protocol path signal and does not repeat these baseline checks.

This removes five Rust job instances: one `workspace-msrv`, three `target-msrv` matrix legs and
one `launcher-msrv`. It retires the old compiler promises while retaining their feature
and platform coverage at the new minimum. The default-feature build and all-target/all-feature
Clippy replace the two workspace checks. No timing or cache-size reduction is claimed here.

The excluded fuzz lock is resolved in Cargo Shim's Ubuntu `workspace` job, in the
`Resolve excluded fuzz workspace` step: `cargo metadata --manifest-path
crates/mango-protocol/fuzz/Cargo.toml --locked --all-features --format-version 1`.
This is a step inside `Workspace (ubuntu-latest)`, not a separate `fuzz-workspace` job or
required check. A stale lock fails the workspace job and its gates. The command deliberately
omits `--no-deps` so Cargo actually resolves the graph; `short-job-folds.unit.test.ts` pins it.

Independent validations and their Bun/nextest setup use `!cancelled()` so a failed check does not
suppress the remaining checks or native tests. Each failure still fails the job and aggregate gate.

The existing checks remain:

| Lane and aggregate gate                      | Command and package/feature scope                                                                                                            | Runner coverage                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `workspace`, `Cargo Shim Gate`               | `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`; `cargo build --workspace --locked`                          | Native Linux x64, macOS arm64 and Windows x64                                                              |
| `workspace`, `Cargo Shim Gate`               | `cargo fmt --all -- --check`                                                                                                                 | Linux x64 only, `ubuntu-latest`                                                                            |
| `workspace`, `Cargo Shim Gate`               | `cargo nextest run --workspace --all-targets --all-features --locked --retries 0`; nextest/libtest inventory parity                          | Native macOS arm64 and Windows x64                                                                         |
| `rust-coverage`, `CI Gate`                   | `cargo llvm-cov --no-report --workspace --all-targets --all-features --locked`, instrumented libtest                                         | Native Linux x64, same Rust path signal                                                                    |
| `workspace`, `Cargo Shim Gate`               | `cargo test --doc --workspace --all-features --locked`; `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --workspace --all-features --locked` | Linux x64; protocol-specific macOS/Windows doctests and docs remain in Protocol CI                         |
| `workspace-windows-arm64`, `Cargo Shim Gate` | `cargo nextest run -p mangostudio-runtime --all-targets --all-features --locked --retries 0`                                                 | Native Windows ARM64, `windows-11-arm`, same Rust path signal                                              |
| `musl-clippy`, `Cargo Shim Gate`             | `cargo-zigbuild clippy --locked -p mangostudio-runtime --all-targets --target <t> -- -D warnings`: runtime, default features                 | Linux cross-checks for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`, same Rust path signal |
| Protocol CI, `Protocol Gate`                 | Protocol feature powerset, interop, schema equality and published-package checks; advisory semver is separate                                | Existing protocol path signal and Linux/macOS/Windows coverage                                             |

Windows ARM64 now compiles the full workspace as well as the launcher alone at 1.99.0. Its native
test command remains scoped to the runtime; full-workspace compilation does not claim native
execution of every crate's tests there. Fuzz-workspace resolution, ignored fixture regeneration
and real-binary qualification retain their commands and relevance predicates.

## Canonical Check evidence

The reusable Check job runs `bun run check --all --ci-report` once and uploads
`qa-check-evidence-<invocation>` for one day. The versioned report binds the
repository, checked-out source SHA, Actions run, producing attempt and a
caller-generated invocation ID. Five component TypeScript workers retain the
existing supervised process and timeout behavior; their completed diagnostics
and the tooling result share this report.

QA downloads that exact report and verifies its identity before consuming the
tooling and TypeScript measurements. A rerun can consume an earlier successful
Check attempt only through its retained producing-attempt and invocation outputs.
Missing, malformed, mismatched or interrupted evidence is unavailable; CI QA does
not rerun the checkers as a fallback. Local QA collection retains its existing
local-check behavior. The report never replaces Check's required verdict.

## Shared production frontend

The existing `Build (frontend + API)` job produces the canonical production
frontend. It binds the executing full Bun revision into the Turbo task hash,
clears old outputs before building, including before a cache hit, records the
artifact identity and uploads it before the independent API ESM build. Distribution preparation, native hub packaging, production browser
assertions and QA consume these bytes.

Verification binds the source SHA, exact producer Bun commit, lockfile, build
environment, build stamp, metafile and complete output inventory. Each consumer
receives the producer's Bun identity; a native hub compiler records its own Bun
identity separately. There is no extra frontend producer job.

Distribution and browser jobs require successful Build. If the API build fails,
the uploaded frontend remains available for diagnosis, but those consumers do
not proceed. QA still collects other available measurements and reports the
frontend bundle unavailable. QA verifies the frontend before downloading
untracked Check, test or coverage evidence into its checkout. Independent clean
release preparation remains available when no shared frontend is supplied.

## Release dry runs

PR CI calls `release-dry-run.yml` in the same run as Distribution Build, even
when release paths are irrelevant. `Release Dry Run Gate` retains relevance-based
skips, and `CI Gate` includes the reusable workflow result. Relevant PR dry runs
download the Linux x64 and Windows x64 content-addressed target bundles on the
job that packages each target. `download-distribution` verifies source, version,
channel, checksums and the light runtime profile.

Each platform packages its verified hub/runtime pair and README with the
prepared `hub-inputs-*` frontend. The extracted README is copied to
`.mango/out/README.md` before archiving. Packaging and installer checks use the
distribution's PR version throughout health, checksum, manifest rendering and
lifecycle assertions. They do not rebuild the hub or runtime. The dry-run gate
accepts the skipped clean runtime producer only on this reuse path.

PR Distribution retains per-target bundles and complete packaging/manifest
validation, but omits the unused aggregate checksum, release-assets and npm
uploads. Main keeps those publication bundles. Daily Canary selects a successful
main-push CI run and promotes its existing shipping artifacts in `canary.yml`
after qualifying its validation producers. No Canary rebuild fallback is
allowed; see [Canary publication](releasing.md#canary-channel).

Weekly and manual dry runs keep separate clean, uncached shipping-profile
runtime and hub builds with version `0.0.0-dryrun`. Linux packaging/Docker checks,
Windows PowerShell 5.1 installer checks and the Cargo publish dry run retain
their command inventory. The main-only light runtime cache seed waits for
successful `CI Gate` and a successful `changes` (Preflight) job, which owns the distribution identity. Hosted reuse and artifact
overhead require current-head qualification; no measured wall-clock reduction
is claimed here.

## Fresh Rust dependencies

`rust-fresh-dependencies.yml` resolves a new root Cargo lockfile each Tuesday and
on manual dispatch, then runs dependency policy and Linux, macOS and Windows
build, clippy, workspace tests and doctests against the same graph. Policy
failures do not skip platform checks. Exact SDK pins remain exact. The resolved lock
is retained as a workflow artifact and never committed. This advisory workflow
does not feed a required PR gate. Failed scheduled or manual runs of `main` update
one bot-owned compatibility issue, preserving maintainer notes; a manual run on
another ref and PR validation of the workflow never write issues. Locked CI and
Dependabot continue independently.

Every run that is not cancelled also keeps a `fresh-rust-receipt` artifact and
step summary beside the `fresh-rust-lockfile` artifact: the source SHA, the
`rustc` and `cargo` that resolved the graph, the SHA-256 of the lock file it
judged (the file, not the artifact archive), and the result of the `resolve`,
`policy` and `fresh` jobs. It names the stage the run ended in:
`resolution-failed` (no lock exists), `lock-not-retained`, `policy-failed`,
`platform-checks-failed`, `policy-and-platform-checks-failed`, `passed` or
`incomplete`. The compatibility issue states the same stage, from the same
classification (`scripts/ci/fresh-dependencies-receipt.mjs`), and links a lock
only when its artifact was retained (a lock that was produced but not uploaded
keeps its hash in the receipt, labelled not retained, without a link). The `fresh` result covers the three operating
systems together. The graph is built and tested with the pinned development
toolchain (1.99.0) and workspace-wide feature unification
(`--workspace --all-features`). It checks the new graph at the shared minimum, but does not
replace default-feature or launcher-only checks against the committed lock. A higher minimum
does not resolve a duplicate-crate dependency-policy failure.

## QA collector timings

`qa-metrics.yml` retains a separate `qa-collector-timings` artifact for seven
days. To collect the same receipt locally, pass
`--timings .mango/artifacts/qa-collector-timings.json` to
`bun scripts/qa-gate/collect.ts`; stdout still contains only the metrics
envelope. Collection remains serial. The receipt records component LoC,
available TypeScript/coverage collectors and the remaining collector durations,
the actual checkout SHA, envelope provenance, Bun/host and runner image.
Nested spans overlap and must not be added together. `returned` means the
function returned, including a partial measurement; it is not a passing QA
verdict. A thrown collector retains its ordinary unavailable/error behavior.

RSS values are snapshots of the parent collector at span boundaries. They do
not measure child processes, peak runner memory or CPU contention. Scheduling
adoption still needs five comparable first-attempt serial/bounded observations,
full envelope parity, subtree/runner resource measurements and critical-path
costs. This instrumentation makes no performance claim. Timing file or upload
failure does not change collection, and the privileged report consumer reads
only `qa-metrics`.

## Rust coverage

The Ubuntu Rust test run is `.github/workflows/rust-coverage.yml`, called from
`ci.yml`, not a step of Cargo Shim: `cargo llvm-cov --no-report --workspace
--all-targets --all-features --locked`, the plain step's flags on the same
libtest runner, instrumented. It lives in the CI run because the QA collector
(`qa-metrics.yml`) can only download artifacts of its own run, and the
privileged publisher reads only that run's `qa-metrics` envelope; an artifact
from a sibling workflow run would need a polling wait in the unprivileged
collector or a second privileged reader of PR-produced bytes.

- It runs when `ci.yml`'s `changes` job sees a path in `RUST_WORKSPACE_PATHS`
  (`scripts/lib/rust-lanes.ts`, the manifest Cargo Shim uses), and always on
  pushes, so every main envelope is a Rust baseline. `CI Gate` accepts its
  skip only under that proof, so a Rust test failure fails `CI Gate`.
- Doctests, the `--ignored` fixture run and real-binary qualification stay in
  Cargo Shim, uninstrumented; macOS and Windows run the plain set there under
  `cargo nextest run --workspace --all-targets --all-features --locked --retries 0`,
  and those two platforms check that nextest lists the same tests as libtest
  (`rust-test-inventory.ts`). Ubuntu executes its full behavioral suite through instrumented libtest;
  it does not run nextest inventory parity. `docs/reference/testing.md` has the details.
- The job holds `contents: read` and uploads `qa-rust-coverage` (`llvm-cov.json`
  and `receipt.json`, 1 day). `scripts/qa-gate/rust-coverage/` reads it in the
  collector into one coverage measurement per crate. When the lane was skipped
  as irrelevant the crates are `unsupported` ("not run"), which is not a gap, so
  a docs-only PR is not `incomplete`; a job that was due and delivered nothing
  is `unavailable`, a failed test run is `partial`, and a crate with no profile
  data is `unavailable`, never 0%.
- `cargo-llvm-cov` is pinned by version in the workflow (through the
  SHA-pinned `taiki-e/install-action`) and `llvm-tools-preview` is added in
  that job only, not to `rust-toolchain.toml`.

## Protocol feature powerset

`protocol-ci.yml` runs `cargo hack clippy -p mango-protocol --feature-powerset`
(36 configurations of the crate's features) on Linux, macOS and Windows.
cargo-hack is pinned by version there and in `protocol-release.yml` (through the
SHA-pinned `taiki-e/install-action`), and `protocol-package.unit.test.ts` keeps
the two equal, so the pull request lane and a release re-run check the same set.

## Concurrency policy

Workflows that declare `concurrency` follow a small set of rules so overlapping
runs are predictable and a newer commit always supersedes an older one:

- **Pull requests.** Workflows triggered by `pull_request` key the concurrency
  group on the PR number (`github.event.pull_request.number`), not the commit
  SHA, so a new push supersedes the previous run even across branch renames or
  forks. Those runs use `cancel-in-progress: true`.
- **Pushes to `main`.** A new push to `refs/heads/main` cancels the run of the
  previous commit, in progress or pending, so only the newest main commit gets
  a verdict. Consumers of exact-commit results (the QA baseline, the light
  runtime cache seed, Canary source selection) must tolerate a main commit
  without a completed run; Canary selects the newest commit that has one.
- **Publish workflows.** `release.yml` and `canary.yml` never cancel mid-publish
  (`cancel-in-progress: false`). Canary serializes scheduled and manual runs,
  retains original version approvals, and checks channel ancestry inside each
  publisher before writes. Cancellation or failure can leave partial publication.
- **Scheduled workflows.** Cron-driven runs other than Canary never cancel in progress.

Reusable workflows do not inherit a `concurrency` group from their caller, but
cancelling the caller cancels the jobs it invoked, so `ci.yml`'s group already
governs called workflows on a PR. Callables that also support
`workflow_dispatch` declare their own group to cover direct runs (for example
`browser-smoke.yml` keys on `github.ref`).

## Native Bun qualification

`.github/workflows/native-bun-qualification.yml` runs the complete
`bun run check` and `bun run test` commands on hosted Linux, macOS and Windows
x64 runners. Changes to the qualification producer or workflow-analysis tools
run both the untouched PR base and the candidate. Other PRs retain the existing
CI gates without repeating these full native suites.

To qualify a branch after rebasing it, dispatch the workflow at that branch:

```sh
gh workflow run native-bun-qualification.yml --ref <branch>
```

The optional `baseline_sha` input adds a baseline at a full commit SHA. Every
run records immutable source identity, toolchains, separate default-runtime and
fake-vendor builds, binary hashes, setup/check/test results, case outcomes and
scoped terminal process observations. Each native job owns its source checkout
and two Cargo targets; it restores no test-result or Cargo-target cache.

The tooling checkout starts the producer with `bun --no-install`. The producer
runs a frozen install in the source checkout and keeps Bun and Cargo downloads
on that runner. The [Bun package trials][native-bun-cache-trials] and
[Cargo registry trial][native-cargo-cache-trial] cover the archive transfer costs.

[native-bun-cache-trials]: https://github.com/juliopolycarpo/mangostudio/issues/2025
[native-cargo-cache-trial]: https://github.com/juliopolycarpo/mangostudio/actions/runs/42932117093

Windows commands start atomically inside a private Job. Membership queries and
retained native handles provide ownership through child exit and captured pipe
EOF. Ordinary commands must leave the Job naturally empty. The two original
Cargo setup commands may close a surviving VCTIP process only after successful
compiler JSON, unchanged runtime or fake-agent features, complete membership
and independently attested installed MSVC path, versions and hash agree. Each
cleanup records the retained handle identity and completion. A VCTIP that was
eligible for that cleanup and leaves the still-open Job by itself first is
recorded as a natural exit instead, with the same identity proof and a stable
snapshot that no longer lists it. Final Job closure
is containment and never establishes successful settlement. Full native
censuses before and after each command reject unattributed compiler helpers.
The TypeScript producer’s outer Windows census runs one PowerShell CIM query
with a 30-second budget; its POSIX `ps` census has 10 seconds. An outer census
that fails or reaches its budget is incomplete, and its error names the elapsed
time and the last phase PowerShell reported on stderr. The Windows Job helper’s
per-command CIM census keeps its separate 10-second operation timeout.

The producer installs its own frozen dependencies and seals its Windows helper
checkout separately from the fresh tested source. Requests containing the inherited environment live outside uploaded
evidence and are deleted after each invocation. Uploaded evidence keeps raw
stdout/stderr, source and tool identities, membership snapshots, explicit
cleanup actions and final open-Job proof. A full census keeps a command line
only for a process the qualification owns; every other process on the runner
is recorded by PID, parent, creation identity and image, plus the compiler-helper
verdict its command line gave. A bounded native Windows probe gate
checks orphan, pipe, PID reuse and crash behavior before full qualification.

Baseline failures remain visible in the receipts and logs. Candidate failures
fail the job. A check failure still permits the complete test command to run,
so workflow-tool setup cannot hide test failures. Hosted native results cover
these producers and their observed process settlement; interactive Ctrl-C,
local hardware and live vendors require their own evidence.

## Workflow hygiene

`scripts/tests/workflow-hygiene.unit.test.ts` enforces repository-wide workflow
policies from the workflow text itself:

- **Job timeouts.** Every job declares `timeout-minutes` instead of inheriting
  GitHub's 360-minute default. Reusable-workflow callers are the one exemption —
  GitHub rejects the key on them — and a paired assertion keeps that exemption
  from widening.
- **PR concurrency keys.** Every workflow with both `pull_request` and
  `concurrency` keys the group on `github.event.pull_request.number` and never
  on `github.sha`.
- **Checkout credentials.** Every `actions/checkout` sets `persist-credentials`
  explicitly, so no checkout inherits the job's `GITHUB_TOKEN` in `.git/config`
  by omission. `false` is the rule; `true` is reserved for the jobs listed in
  `CREDENTIAL_ALLOWLIST`, which do authenticated git network work:

  | Workflow           | Job       | Git network operation                    |
  | ------------------ | --------- | ---------------------------------------- |
  | `pr-qa-report.yml` | `report`  | fetches `refs/pull/N/head` from `origin` |
  | `release.yml`      | `prepare` | fetches `main` to verify the tagged SHA  |

Adding an allowlist entry is a security decision: every step after the checkout,
including transitively installed tooling, can read a persisted token. Jobs that
only run local git commands (`rev-parse`, `diff`, `git-cliff`) need no
credential, and `gh` reads `GH_TOKEN` from the environment rather than
`.git/config`. `scripts/release/push-dist-repo.ts` carries its own
per-invocation credential and is unaffected.

## Dependency-free jobs

Some CI jobs run only the repository-pinned Bun binary and never call
`bun install` or restore CI caches. They execute small TypeScript entrypoints
whose import graph stays inside the checkout (no `node_modules`).

| Workflow           | Job(s)               | Setup                          |
| ------------------ | -------------------- | ------------------------------ |
| `ci.yml`           | `gate`               | `setup-bun` only               |
| `smoke-binary.yml` | `binary` (default)   | `setup-bun` only               |
| `smoke-binary.yml` | `binary` (`rebuild`) | `setup-mango` (full toolchain) |

`setup-bun` is the local composite at `.github/actions/setup-bun`. It wraps
`oven-sh/setup-bun` with two retries, after 60 and 180 seconds, for transient canary download
failures, and `setup-mango` calls it too. Do not call `oven-sh/setup-bun`
from a workflow; `bun-toolchain.unit.test.ts` allows only the release trust
bootstraps, which cannot load an action from an unverified tag.

The Linux `binary` jobs also stage and test the Bookworm and Alpine Docker
images. `smoke-container.yml` runs all four Docker/Podman and glibc/musl
transport pairings in one job with one `setup-mango` dependency install.
Its suites start only once checkout, setup and both runtime downloads have
succeeded; after that, one failed pairing does not stop the others.
The pairing script derives the suite engine from `CONTAINER_CLI`, so preparation
and the transport tests always use the same engine.

Every step in both smoke jobs declares its own `timeout-minutes`, setup,
downloads and teardown checks included. A step deadline fails only that step; the
job deadline cancels the job and skips the later `!cancelled()` assertions and
teardown checks. `scripts/tests/smoke-workflows.unit.test.ts` therefore fails
when a step has no positive integer deadline, or when the deadlines one leg can run in sequence
(a matrix platform in rebuild or prebuilt mode) total the job's 30 minutes or
more. Runner provisioning and post-action cleanup take no step deadline and sit
outside that sum.

The budget omits a step only when a top-level condition term proves it cannot
run on that leg. Operators inside quoted Actions strings do not split terms;
unknown terms stay budgeted unless another top-level term proves the step cannot
run. Unmatched quotes or parentheses keep the whole condition unknown.

Smoke scripts run as `bun --no-install …` so a stray package import fails
instead of silently auto-installing. `scripts/tests/smoke-dependencies.unit.test.ts`
walks the smoke script entrypoints declared in the workflow and download
composite and asserts they have no external runtime imports.

Browser smoke deliberately sets `API_HOST=127.0.0.1` for its IPv4 test endpoint. Native
binary smoke instead clears both `API_HOST` and `MANGOSTUDIO_DEFAULT_API_HOST`, starts with
only a port argument, and checks that server state records the default `localhost` bind on
all six native targets. Container images use the process-only
`MANGOSTUDIO_DEFAULT_API_HOST=0.0.0.0` fallback, below explicit CLI, `API_HOST`, `.env` and
TOML host configuration. These smoke paths qualify different bind contracts; see
`tests/browser-smoke/support/smoke-home.ts`, `scripts/release/smoke-binary.sh` and the two Dockerfiles.

## Branch protection / required checks

The active [main ruleset](https://github.com/juliopolycarpo/mangostudio/rules/14350640)
(ID `14350640`) was migrated and read back on **2026-11-04**. Its exact required
contexts are:

| Required API context                     | Application ID / slug                | Producer                                               |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `CI Gate`                                | `15368` / `github-actions`           | `ci.yml`, job `gate-unique`                            |
| `Cargo Shim Gate`                        | `15368` / `github-actions`           | `cargo-shim.yml`, job `gate-unique`                    |
| `Protocol Gate`                          | `15368` / `github-actions`           | `protocol-ci.yml`, job `gate-unique`                   |
| `Release Dry Run / Release Dry Run Gate` | `15368` / `github-actions`           | `release-dry-run.yml`, job `gate-unique`, called by CI |
| `Dependency Review`                      | `15368` / `github-actions`           | `dependency-review.yml`, job `dependency-review`       |
| `CodeQL`                                 | `57789` / `github-advanced-security` | Code scanning results from `codeql.yml`                |
| `Apply path-based labels`                | `15368` / `github-actions`           | `labeler.yml`, job `label`                             |

`Verify classification labels` is a step in `Apply path-based labels`, not a
required context. All four unique aggregate contexts were verified before
replacing the ambiguous `Gate` requirement. Application IDs, strict-status
policy, conditions, bypass actors and every other rule were retained.

The [producer receipts and cutover history](./ci-gates.md) preserve the earlier
shared-name inventory and the migration evidence. Do not substitute internal
jobs, matrix cells or a predicted reusable context for a verified required
context. Ruleset changes are separate GitHub settings operations; publishing
remains restricted to tags and pushes to `main`.

### Temporary integration branches

Use a base branch under `stack/**` for dependent pull requests. CI, Cargo Shim,
Protocol CI, CodeQL and Dependency Review accept both `main` and `stack/**` on
`pull_request`; their push triggers stay restricted to `main`. A stack PR receives
validation without gaining a publication path or a duplicate feature-branch push run.

Keep one-off branch names out of the workflow filters and their test assertions.
Follow the [stacked pull request procedure](./ci-gates.md#stacked-pull-requests)
for restacking, retargeting and the validation required before landing on `main`.

## Related

- Release pipeline and dry-run behavior: [`releasing.md`](./releasing.md)
- Local QA gates and test taxonomy: [`testing.md`](./testing.md)
- Simplification decisions and measured limits: [`ci-optimization-evidence.md`](./ci-optimization-evidence.md)
- Gate evaluator: `scripts/ci/evaluate-gate.ts`
