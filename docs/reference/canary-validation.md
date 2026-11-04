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
| `.github/workflows/codeql.yml`      | `Analyze (javascript-typescript)`, `Analyze (rust)`, and `Analyze (rust, windows)` on every main push                                                             |

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
sibling run is checked even when its path filter was irrelevant. CodeQL is always
required.

Authentication failures, failed API calls, malformed pages and missing mandatory
results fail closed. The receipt records source identity, job IDs and attempts,
sibling run IDs, and the relevance reason for the publication summary.
