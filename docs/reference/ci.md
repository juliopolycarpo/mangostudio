# Continuous Integration

How MangoStudio gates merges on `main` and the temporary `feat/rust-runtime`
integration branch, and which GitHub checks are safe to require in repository rules.

## Aggregate gates

Each gated workflow ends with an always-reporting job named `Gate`. That job
`needs` every mandatory lane, runs with `if: always()`, and evaluates dependency
results through `scripts/ci/evaluate-gate.ts`. Branch protection and Canary
depend on these stable names instead of tracking internal job names, matrix
shapes, or path filters.

| Workflow check name      | Workflow                                | Role                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI / Gate`              | `.github/workflows/ci.yml`              | Always reports; Canary also depends on this gate; accepts `distribution` and `smoke` skips when only documentation-surface paths changed, `rust-coverage` when no Rust-relevant path changed, and `qa-metrics` on `workflow_dispatch`                |
| `Cargo Shim / Gate`      | `.github/workflows/cargo-shim.yml`      | Stable legacy check name for the root Rust workspace; runs the locked build on Linux, macOS and Windows, the plain test run on macOS and Windows (Linux's is `Rust Coverage` in `CI / Gate`), the launcher MSRV check, and fuzz-workspace resolution |
| `Release Dry Run / Gate` | `.github/workflows/release-dry-run.yml` | Always reports; accepts each dry-run lane skip when irrelevant                                                                                                                                                                                       |

Unit tests in `scripts/tests/ci-gate.unit.test.ts` derive each gate's expected
`needs` from the workflow text: every job except the gate itself and any job
that already depends on the gate. Adding a mandatory lane without wiring it into
the gate fails the test.

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
  Cargo Shim, uninstrumented; macOS and Windows keep the plain run there.
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
| `smoke-binary.yml` | `binary`, `docker` (default)    | `oven-sh/setup-bun` only       |
| `smoke-binary.yml` | `binary`, `docker` (`rebuild`)  | `setup-mango` (full toolchain) |

Smoke scripts run as `bun --no-install …` so a stray package import fails
instead of silently auto-installing. `scripts/tests/smoke-dependencies.unit.test.ts`
walks the smoke script entrypoints declared in the workflow and download
composite and asserts they have no external runtime imports.

## Branch protection / required checks

Required checks on `main` and, while the Rust migration is active,
`feat/rust-runtime` should be the three stable gates above, plus the independent
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
Publishing remains restricted to tags and pushes to `main`; a pull request that
targets `feat/rust-runtime` must run checks without gaining a publish path.

## Related

- Release pipeline and dry-run behavior: [`releasing.md`](./releasing.md)
- Local QA gates and test taxonomy: [`testing.md`](./testing.md)
- Gate evaluator: `scripts/ci/evaluate-gate.ts`
