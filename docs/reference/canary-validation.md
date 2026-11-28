# Canary source qualification

The source qualifier (`scripts/ci/qualify-canary-source.ts`) validates a frozen CI
run before distribution promotion. Its inputs are `REPO`, `SOURCE_RUN_ID`,
`SOURCE_RUN_ATTEMPT`, and the full `SOURCE_SHA`. It writes a JSON evidence receipt
to `QUALIFICATION_RECEIPT` and the `qualified` and `builder_attempt` job outputs.
This helper does not publish packages or releases.

## Required producers

| Workflow                            | Required successful jobs                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`          | `CI Gate`, `Distribution / Build immutable distribution`, all six native `Smoke — Binary / Binary <platform>` legs, and `Smoke — Container / Container transport` |
| `.github/workflows/cargo-shim.yml`  | `Cargo Shim Gate` when the push touches its qualification paths                                                                                                   |
| `.github/workflows/protocol-ci.yml` | `Protocol Gate` when the push touches its protocol paths                                                                                                          |
| `.github/workflows/codeql.yml`      | `Analyze (javascript-typescript)` on every main push; `Analyze (rust)` and `Analyze (rust, windows)` on the SHA, or a covering earlier analysis (see below)       |

Each run must belong to this repository and its expected workflow ID/path, use
`push` on `main`, name the selected SHA, and finish successfully. The qualifier
never accepts a bare `Gate` check from an unknown producer. The CI gate owns its
remaining mandatory checks and skip rules. Main pushes always run distribution
and smoke. Binary smoke's manual-rebuild `Runtime` job may skip because main
consumes prebuilt targets; native Linux smoke also exercises glibc and musl
containers. Container transport covers Docker and Podman with both variants.
The PR-only release dry run, Dependency Review and classification jobs, and
periodic qualification workflows are outside the required main validation set.

The complete CI workflow must succeed. A failed light-runtime cache seed therefore
disqualifies the source even if `CI Gate` passed. This strict policy preserves the
seed's PR-cache function and does not reinterpret a failed workflow as green.

## Source window

Canary selects its source only among successful `main` push CI runs created in
the last 30 days, the retention of main publication bundles. Qualification
reads the frozen run directly and has no window of its own: a recovered or
restored older run still qualifies if its evidence has not expired. See
[Canary channel](releasing.md#canary-channel) for the selection rules.

## Partial reruns and compatibility

For each job name, the qualifier takes the newest producer attempt no later than
the frozen successful run attempt. Earlier successful jobs may be reused by a
partial rerun. A newer failed, cancelled, skipped or pending producer blocks
qualification. Gate and smoke evidence cannot predate a rebuilt distribution.
The qualifier reads the exact frozen successful attempt. A later rerun cannot
substitute mutable run metadata or future producer jobs for that approval. A
response naming a different run or attempt than the frozen endpoint is rejected.

Producer contracts are checked against the selected source. The CI, distribution,
binary smoke, container smoke, Cargo Shim, Protocol CI and CodeQL workflow files
must have the same bytes as the qualification revision. Matching job names do not
prove matching coverage. An incompatible source fails with an explicit reason;
select a successful source with the reviewed contracts or review and update this
compatibility policy.

A missing path-filtered sibling is allowed only after a complete, nondivergent
comparison from the exact push event's `before` SHA proves irrelevance. The caller
must first verify an immutable, source-associated CI push-context receipt before
supplying that SHA as `VERIFIED_PUSH_BEFORE_SHA` (or `pushBeforeSha` to the library).
This input is trusted evidence from the artifact verifier, never a user-selected
workflow dispatch value. The helper does not establish artifact trust itself.
Legacy runs without that receipt require both sibling runs. A preceding observed
CI run cannot prove the push boundary: an intervening push can skip CI or its run
can be deleted, and a later revert can hide the selected push's relevant paths.

An authenticated comparison with an explicit empty file list proves no net path
changes and permits the filtered siblings to be absent. A missing file list does
not establish that proof.

The whole push range matters, including both sides of renames; the head commit's
first parent alone is insufficient. The qualifier uses the canonical Cargo Shim
and Protocol predicates. If those predicate files differ at the selected source,
if the exact push range is unknown/divergent, or if GitHub's 300-file comparison
limit could truncate it, both siblings are required conservatively. An existing
sibling run is checked even when its path filter was irrelevant. The CodeQL run
and its JavaScript analysis are always required.

The two CodeQL Rust analyses follow a separate rule, because `codeql.yml` skips
them on a main push whose Rust inputs match an earlier analysis. The qualifier
accepts either both Rust jobs succeeded on the SHA, or both skipped and covered.
It never trusts the run's own skip decision. Instead it reads main's code
scanning analyses (`GET /code-scanning/analyses?ref=refs/heads/main`, newest
first, at most five pages), keeps commits whose `CodeQL` analyses from the
`analyze-rust` job have no upload error in both `/language:rust` and
`/language:rust/windows`, and tries the newest five. A candidate covers the SHA
when it is the SHA itself, or when the compare API shows a complete linear range
(either direction, under 300 files, both sides of renames) with no path matching
`CODEQL_RUST_PATTERN`. The comparison is against the last analyzed commit, never
the push's parent: a superseded main run can leave a Rust change without an
analysis, and the next commit then differs from the last analyzed one by that
change. A skipped, uncovered SHA is rejected, as is any lookup failure, a partial
Rust verdict (one leg ran, one skipped) and a source whose `scripts/lib/ci-lanes.ts`
differs from the qualification revision. The receipt records the outcome in
`codeqlRust`. This lookup needs `security-events: read` in the three `canary.yml`
jobs that qualify.

Cargo Shim and Protocol CI do not have this protection: their push path filter
compares the push's own range, so a Rust change whose run was cancelled does not
force the next push to rerun them.

Authentication failures, failed API calls, malformed pages and missing mandatory
results fail closed. The receipt records source identity, job IDs and attempts,
sibling run IDs, and the relevance reason for the publication summary.
