# Continuous Integration

How MangoStudio gates merges on `main`, and which GitHub checks are safe to require in
repository rules.

## Aggregate gates

Each gated workflow ends with an always-reporting job named `Gate`. That job
`needs` every mandatory lane, runs with `if: always()`, and evaluates dependency
results through `scripts/ci/evaluate-gate.ts`. Branch protection and Canary
depend on these stable names instead of tracking internal job names, matrix
shapes, or path filters.

| Workflow check name      | Workflow                                | Role                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI / Gate`              | `.github/workflows/ci.yml`              | Always reports; Canary depends on it; accepts distribution/smoke skips for documentation-only paths, Rust coverage for irrelevant paths, QA on dispatch, and the PR-only release dry run on non-PR events                                            |
| `Cargo Shim / Gate`      | `.github/workflows/cargo-shim.yml`      | Stable legacy check name for the root Rust workspace; runs locked checks and builds at the Rust 1.99.0 minimum on Linux, macOS and Windows, native tests on macOS and Windows, Windows ARM64 checks and runtime tests, and fuzz-workspace resolution |
| `Protocol CI / Gate`     | `.github/workflows/protocol-ci.yml`     | Always reports; accepts every protocol lane skip when no protocol path changed                                                                                                                                                                       |
| `Release Dry Run / Gate` | `.github/workflows/release-dry-run.yml` | Called by every PR CI run; accepts irrelevant assertion lanes and the clean runtime producer on the verified same-run PR reuse path                                                                                                                  |

Repository rules match required checks by the name `Gate`, and all four workflows
above retain that compatibility job name. CI calls the reusable release dry run
on every PR; the other gated workflows start directly on `pull_request` without
workflow-level path filters. Allowed skips require their relevance proof or the
explicit PR-reuse/non-PR execution mode. Verify the current hosted producer
identities before changing required contexts.

Unit tests in `scripts/tests/ci-gate.unit.test.ts` derive each gate's expected
`needs` from the workflow text: every job except the gate itself and any job
that already depends on the gate. Adding a mandatory lane without wiring it into
the gate fails the test.

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

| Before                   | Command and package/feature scope                                                                                                                                                                              | Target and runner before                                                                            | Replacement at 1.99.0                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --locked`: workspace libraries/binaries, default features                                                                                                                             | Linux x64, `ubuntu-latest`                                                                          | `workspace` on Linux x64, macOS arm64 and Windows x64, same command                                       |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --all-targets --all-features --locked`: workspace, every target kind and feature                                                                                                      | Linux x64, `ubuntu-latest`                                                                          | `workspace` on Linux x64, macOS arm64 and Windows x64, same command                                       |
| `target-msrv`, 1.97.0    | `cargo check --workspace --all-targets --all-features --locked --target <t>`: full workspace                                                                                                                   | `aarch64-apple-darwin` on `macos-latest`; `x86_64-pc-windows-msvc` on `windows-latest`, both native | `workspace` on each native runner, same scope/features through its host target                            |
| `target-msrv`, 1.97.0    | Same full-workspace check, `--target aarch64-pc-windows-msvc`                                                                                                                                                  | Windows ARM64 cross-check from x64 `windows-latest`                                                 | `workspace-windows-arm64` on native `windows-11-arm`, same command and explicit target                    |
| `target-msrv`, 1.96.0    | `cargo check -p mangostudio --all-targets --locked --target <t>`: launcher alone, default features                                                                                                             | Native macOS arm64 and Windows x64                                                                  | `workspace` on those runners, `cargo check -p mangostudio --all-targets --locked`; also runs on Linux x64 |
| `target-msrv`, 1.96.0    | Same launcher-only check, `--target aarch64-pc-windows-msvc`                                                                                                                                                   | Windows ARM64 cross-check from x64 `windows-latest`                                                 | `workspace-windows-arm64` on native `windows-11-arm`, same command and explicit target                    |
| `launcher-msrv`, 1.96.0  | `cargo check -p mangostudio --all-targets --locked`, `cargo clippy -p mangostudio --all-targets --locked -- -D warnings`, `cargo test -p mangostudio --all-targets --locked`: launcher alone, default features | Linux x64, `ubuntu-latest`                                                                          | Ubuntu `workspace` retains all three commands; launcher checks also run on macOS arm64 and Windows x64    |

Every row uses the same `RUST_WORKSPACE_PATHS` signal in `scripts/lib/rust-lanes.ts` before and
after the move, and feeds `Cargo Shim / Gate`. `crates/**` selects runtime-only changes, and
`spec/**` and the other inputs the crates read select protocol changes. Pull requests without a
matching Rust path skip the Rust jobs under the gate's relevance proof; the gate still reports.
Pushes selected by the workflow filter and manual dispatches run the Rust jobs. Protocol CI keeps
its own protocol path signal and does not repeat these baseline checks.

This removes five Rust job instances: one `workspace-msrv`, three `target-msrv` matrix legs and
one `launcher-msrv`. It retires the old compiler promises while retaining their command, feature
and platform coverage at the new minimum. No timing or cache-size reduction is claimed here.

Independent validations and their Bun/nextest setup use `!cancelled()` so a failed check does not
suppress the remaining checks or native tests. Each failure still fails the job and aggregate gate.

The existing checks remain:

| Lane and aggregate gate                        | Command and package/feature scope                                                                                                                 | Runner coverage                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `workspace`, `Cargo Shim / Gate`               | `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`; `cargo build --workspace --locked` | Native Linux x64, macOS arm64 and Windows x64                                                              |
| `workspace`, `Cargo Shim / Gate`               | `cargo nextest run --workspace --all-targets --all-features --locked --retries 0`; nextest/libtest inventory parity                               | Native macOS arm64 and Windows x64; inventory parity also runs on Linux x64                                |
| `rust-coverage`, `CI / Gate`                   | `cargo llvm-cov --no-report --workspace --all-targets --all-features --locked`, instrumented libtest                                              | Native Linux x64, same Rust path signal                                                                    |
| `workspace`, `Cargo Shim / Gate`               | `cargo test --doc --workspace --all-features --locked`; `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --workspace --all-features --locked`      | Linux x64; protocol-specific macOS/Windows doctests and docs remain in Protocol CI                         |
| `workspace-windows-arm64`, `Cargo Shim / Gate` | `cargo nextest run -p mangostudio-runtime --all-targets --all-features --locked --retries 0`                                                      | Native Windows ARM64, `windows-11-arm`, same Rust path signal                                              |
| `musl-clippy`, `Cargo Shim / Gate`             | `cargo-zigbuild clippy --locked -p mangostudio-runtime --all-targets --target <t> -- -D warnings`: runtime, default features                      | Linux cross-checks for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`, same Rust path signal |
| Protocol CI, `Protocol CI / Gate`              | Protocol feature powerset, interop, schema equality, semver and published-package checks                                                          | Existing protocol path signal and Linux/macOS/Windows coverage                                             |

Windows ARM64 now compiles the full workspace as well as the launcher alone at 1.99.0. Its native
test command remains scoped to the runtime; full-workspace compilation does not claim native
execution of every crate's tests there. Fuzz-workspace resolution, ignored fixture regeneration
and real-binary qualification retain their commands and relevance predicates.

## Release dry runs

PR CI calls `release-dry-run.yml` in the same run as Distribution Build, even
when release paths are irrelevant. Its internal Gate retains relevance-based
skips and both CI gates include the reusable workflow result. Relevant PR dry runs
download the Linux x64 and Windows x64 content-addressed target bundles,
verify source, version, channel and checksums through `download-distribution`,
and stage their light-profile runtimes for the existing hub build and packaging checks.
They use the distribution's PR version throughout installer, health, checksum,
manifest rendering and lifecycle assertions. Both release dry-run gates accept
the skipped clean runtime producer on this reuse path. On main pushes, Canary
and the light runtime cache seed explicitly require successful direct producers
after Gate accepts the skipped PR-only dry run.

Weekly and manual dry runs keep separate clean, uncached shipping-profile
runtime builds and the `0.0.0-dryrun` version. The Linux packaging/Docker checks,
Windows PowerShell 5.1 installer checks and Cargo publish dry run retain their
complete command inventory. This removes duplicate PR runtime compilation;
hosted check identities, artifact overhead and timing still require validation
on the opened PR before merge. It makes no measured wall-clock claim.

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
  pushes, so every main envelope is a Rust baseline. `CI / Gate` accepts its
  skip only under that proof, so a Rust test failure is a `CI / Gate` failure.
- Doctests, the `--ignored` fixture run and real-binary qualification stay in
  Cargo Shim, uninstrumented; macOS and Windows run the plain set there under
  `cargo nextest run --workspace --all-targets --all-features --locked --retries 0`,
  and every OS checks that nextest lists the same tests as libtest
  (`rust-test-inventory.ts`). `docs/reference/testing.md` has the details.
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
runs are predictable and `main` never loses a green publish path:

- **Pull requests.** Workflows triggered by `pull_request` key the concurrency
  group on the PR number (`github.event.pull_request.number`), not the commit
  SHA, so a new push supersedes the previous run even across branch renames or
  forks. Those runs use `cancel-in-progress: true` unless the workflow also
  serves pushes to `main` (see below).
- **Pushes to `main`.** Runs on `refs/heads/main` are never cancelled in
  progress, so every green commit can reach Canary and downstream publish steps.
- **Publish workflows.** `release.yml` never cancels mid-publish
  (`cancel-in-progress: false`). `canary.yml` is the exception: it cancels
  in-flight canary publishes so only the newest green commit owns the npm
  `canary` dist-tag; per-commit versions are unique, and canary now cuts one
  immutable GitHub release per commit, so superseding does not leave a
  half-published conflict.
- **Scheduled workflows.** Cron-driven runs never cancel in progress.

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

| Workflow           | Job(s)                          | Setup                          |
| ------------------ | ------------------------------- | ------------------------------ |
| `ci.yml`           | `gate`, `distribution-identity` | `oven-sh/setup-bun` only       |
| `smoke-binary.yml` | `binary` (default)              | `oven-sh/setup-bun` only       |
| `smoke-binary.yml` | `binary` (`rebuild`)            | `setup-mango` (full toolchain) |

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

## Branch protection / required checks

Required checks on `main` should be the stable `Gate` checks above, plus the independent
security / process checks that are not folded into those gates:

- `CI / Gate`
- `Cargo Shim / Gate`
- `Release Dry Run / Gate`
- CodeQL
- Dependency review
- Verify classification labels

Do **not** require internal job names, reusable-workflow job names, or matrix
check names (for example `Check`, `Test`, `Build`, or a smoke matrix cell). Those
rename or reshape as the workflows evolve; the gate unit tests already enforce
that every mandatory lane feeds a gate.

Updating the repository ruleset itself is a GitHub settings operation, not a
commit. After changing which checks are required, keep this section in sync.
Publishing remains restricted to tags and pushes to `main`.

### Temporary integration branches

The gated workflows filter `pull_request` by base branch, and the list is `[main]`. A pull
request that targets any other branch starts none of them. A temporary integration branch turns
them on by adding its own name to those lists in a commit on that branch, together with the
assertions in `scripts/tests/ci-gate.unit.test.ts` and
`scripts/tests/security-workflows.unit.test.ts` that pin the lists. Such a pull request must run
checks without gaining a publish path.

Remove the entry when the branch is retired. `main` should not name a branch that no longer
exists.

## Related

- Release pipeline and dry-run behavior: [`releasing.md`](./releasing.md)
- Local QA gates and test taxonomy: [`testing.md`](./testing.md)
- Gate evaluator: `scripts/ci/evaluate-gate.ts`
