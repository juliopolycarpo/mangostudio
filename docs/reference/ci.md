# Continuous Integration

How MangoStudio gates merges on `main`, and which GitHub checks are safe to
require in branch protection.

## Aggregate gates

Each gated workflow ends with an always-reporting job named `Gate`. That job
`needs` every mandatory lane, runs with `if: always()`, and evaluates dependency
results through `scripts/ci/evaluate-gate.ts`. Branch protection and Canary
depend on these stable names instead of tracking internal job names, matrix
shapes, or path filters.

| Workflow check name      | Workflow                                | Role                                                                 |
| ------------------------ | --------------------------------------- | -------------------------------------------------------------------- |
| `CI / Gate`              | `.github/workflows/ci.yml`              | Mandatory PR / `main` correctness; Canary also depends on this gate  |
| `Cargo Shim / Gate`      | `.github/workflows/cargo-shim.yml`      | Always reports; accepts the Rust lane skip when no Rust path changed |
| `Release Dry Run / Gate` | `.github/workflows/release-dry-run.yml` | Always reports; accepts each dry-run lane skip when irrelevant       |

Unit tests in `scripts/tests/ci-gate.unit.test.ts` derive each gate's expected
`needs` from the workflow text: every job except the gate itself and any job
that already depends on the gate. Adding a mandatory lane without wiring it into
the gate fails the test.

## Branch protection / required checks

Required checks on `main` should be the three stable gates above, plus the
independent security / process checks that are not folded into those gates:

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

## Related

- Release pipeline and dry-run behavior: [`releasing.md`](./releasing.md)
- Local QA gates and test taxonomy: [`testing.md`](./testing.md)
- Gate evaluator: `scripts/ci/evaluate-gate.ts`
