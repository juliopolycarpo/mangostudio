# CI gate producers and ruleset handoff

The authoritative aggregate jobs are `gate-unique`, named `CI Gate`,
`Cargo Shim Gate`, `Protocol Gate` and `Release Dry Run Gate`. CI calls Release
Dry Run, whose PR context is `Release Dry Run / Release Dry Run Gate`.
Each aggregate directly evaluates mandatory producer results with `always()`;
failure, cancellation, missing results and unexpected skips fail closed.
Only explicitly proven irrelevant lanes may skip. CI permits QA metrics to
skip on manual dispatch. The main-only light cache seed waits for `CI Gate`.

Canary independently verifies successful CI and relevant sibling workflow
producers and their unique gate names. It does not depend on bare `Gate`.

The main ruleset `14350640` was migrated on 2026-11-04 after verifying the
seven required contexts at PR #1862 head `aa86dd856d774f2ec43602bb6017433787bedb5c`
and docs-only PR #1838 head `d47ad9a3`. The read-back requires all four unique
aggregate contexts and retains Dependency Review, CodeQL and path-based labels.
Application IDs, strict-status policy, conditions, bypass actors and every
other rule remain unchanged. The snapshots below retain the earlier history.

## Read-only refresh, 2026-10-23

The active main ruleset `14350640` still requires the four contexts listed in the historical
snapshot below: `Gate`, `Dependency Review` and `Apply path-based labels` from application
`15368` (`github-actions`), plus `CodeQL` from application `57789`
(`github-advanced-security`). Its strict-status policy remains `false`, and
`do_not_enforce_on_create` remains `false`. No enforcement cutover has occurred.

The check-runs API for PR head `b9e31a681b60b4c0c6650636d6ca8920e6f62243` confirms the
current reusable PR topology. Each receipt below reports success from application `15368`;
the Actions run API identifies CI, Cargo Shim and Protocol CI as the direct workflow producers.
Release Dry Run now runs inside CI. The earlier standalone receipts remain dated history.

| Workflow / job ID                                           | Legacy API context and receipt                                                                                                    | Additive API context and receipt                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` / `gate`, `gate-unique`                            | [`Gate`, 120158081874](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189457/job/120158081874)                   | [`CI Gate`, 120158081850](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189457/job/120158081850)                                |
| `cargo-shim.yml` / `gate`, `gate-unique`                    | [`Gate`, 120155707521](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189264/job/120155707521)                   | [`Cargo Shim Gate`, 120155707463](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189264/job/120155707463)                        |
| `protocol-ci.yml` / `gate`, `gate-unique`                   | [`Gate`, 120155712857](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189236/job/120155712857)                   | [`Protocol Gate`, 120155712981](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189236/job/120155712981)                          |
| `release-dry-run.yml` / `gate`, `gate-unique`, called by CI | [`Release Dry Run / Gate`, 120155787314](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189457/job/120155787314) | [`Release Dry Run / Release Dry Run Gate`, 120155787367](https://github.com/juliopolycarpo/mangostudio/actions/runs/39874189457/job/120155787367) |

The same head reports successful `Dependency Review` (check `120155650636`, app `15368`),
`CodeQL` (`120156510046`, app `57789`) and `Apply path-based labels` (`120155641692`, app
`15368`). `Verify classification labels` is a step of that last job. These receipts verify
producer names at one head, not the remaining hosted cutover case matrix or GitHub's
handling of ambiguous required names.

Reproduce this refresh with read-only API requests:

```bash
gh api repos/juliopolycarpo/mangostudio/rulesets/14350640
gh api 'repos/juliopolycarpo/mangostudio/commits/b9e31a681b60b4c0c6650636d6ca8920e6f62243/check-runs?per_page=100' --paginate
gh api repos/juliopolycarpo/mangostudio/actions/runs/39874189457
gh api repos/juliopolycarpo/mangostudio/actions/runs/39874189264
gh api repos/juliopolycarpo/mangostudio/actions/runs/39874189236
```

## Read-only snapshot, 2026-10-13

The live [main ruleset](https://github.com/juliopolycarpo/mangostudio/rules/14350640), ID
`14350640`, was active. Its required contexts were:

| Context                   | Application ID                       | Producer                                         |
| ------------------------- | ------------------------------------ | ------------------------------------------------ |
| `Gate`                    | `15368` (`github-actions`)           | Four workflows below share this context          |
| `Dependency Review`       | `15368` (`github-actions`)           | `dependency-review.yml`, job `dependency-review` |
| `CodeQL`                  | `57789` (`github-advanced-security`) | Code scanning results from `codeql.yml`          |
| `Apply path-based labels` | `15368` (`github-actions`)           | `labeler.yml`, job `label`                       |

The strict required-status policy was `false`; `do_not_enforce_on_create` was `false`. The
ruleset also enforced deletion protection, pull requests, non-fast-forward protection,
signatures, and linear history. This change does not edit any ruleset field or bypass actor.

The check-runs API for PR head `9f5b62bd46fcdef32604bde09b29e9ac29e913f4` reported four distinct
successful `Gate` checks from application `15368`. The workflow-run API resolved each check's
run ID to its source workflow. This is a producer inventory, not proof of how GitHub handles
ambiguous required names; no bypass was demonstrated.

| Workflow and job               | Legacy check receipt                                                                                    | Additive context       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| `ci.yml` / `gate`              | [115243091618](https://github.com/juliopolycarpo/mangostudio/actions/runs/38379796568/job/115243091618) | `CI Gate`              |
| `cargo-shim.yml` / `gate`      | [115237158932](https://github.com/juliopolycarpo/mangostudio/actions/runs/38379796531/job/115237158932) | `Cargo Shim Gate`      |
| `protocol-ci.yml` / `gate`     | [115237143505](https://github.com/juliopolycarpo/mangostudio/actions/runs/38379796748/job/115237143505) | `Protocol Gate`        |
| `release-dry-run.yml` / `gate` | [115237168502](https://github.com/juliopolycarpo/mangostudio/actions/runs/38379796623/job/115237168502) | `Release Dry Run Gate` |

Each additive producer uses job ID `gate-unique` in its respective workflow. Standalone
workflows use the leaf job names as API contexts; reusable callers add their job-name prefix.
Use the final topology's check-runs API to confirm context names and application IDs before
enforcement changes.

The same PR-head snapshot verified successful security and label contexts:

- [Dependency Review, check 115237078671](https://github.com/juliopolycarpo/mangostudio/actions/runs/38379796711/job/115237078671), application `15368`, `pull_request`.
- [CodeQL, check 115238356758](https://github.com/juliopolycarpo/mangostudio/runs/115238356758), application `57789`.
- [Apply path-based labels, check 115237078327](https://github.com/juliopolycarpo/mangostudio/actions/runs/38379796208/job/115237078327), application `15368`, `pull_request_target`.

On main head `acf8930f7eb4654020c333a708c01eb2fac3b971`, the observed `Gate` came from CI
[check 115249661537](https://github.com/juliopolycarpo/mangostudio/actions/runs/38381698650/job/115249661537).
Cargo Shim and Protocol CI keep path filters on their push triggers; Release Dry Run has no
push trigger. At this snapshot, all four workflows ran directly on every PR targeting main,
including docs-only PRs.

Reproduce the snapshot with read-only API requests:

```bash
gh api repos/juliopolycarpo/mangostudio/rulesets/14350640
gh api 'repos/juliopolycarpo/mangostudio/commits/9f5b62bd46fcdef32604bde09b29e9ac29e913f4/check-runs?per_page=100' --paginate
gh api repos/juliopolycarpo/mangostudio/actions/runs/38379796568
gh api repos/juliopolycarpo/mangostudio/actions/runs/38379796531
gh api repos/juliopolycarpo/mangostudio/actions/runs/38379796748
gh api repos/juliopolycarpo/mangostudio/actions/runs/38379796623
```

## Required-context migration

The 2026-11-04 read-back confirms the following required contexts. Reusable
Release Dry Run reports its prefixed name on PRs; standalone scheduled/manual
runs report the leaf name and are not PR enforcement targets.

```json
[
  { "context": "CI Gate", "integration_id": 15368 },
  { "context": "Cargo Shim Gate", "integration_id": 15368 },
  { "context": "Protocol Gate", "integration_id": 15368 },
  { "context": "Release Dry Run / Release Dry Run Gate", "integration_id": 15368 },
  { "context": "Dependency Review", "integration_id": 15368 },
  { "context": "CodeQL", "integration_id": 57789 },
  { "context": "Apply path-based labels", "integration_id": 15368 }
]
```

The cutover replaced only bare `Gate` with the four unique aggregates. Future
topology changes must verify actual PR context names and application IDs before
changing these settings. Canary independently verifies its expected successful
workflow producers and unique aggregate names.

## Verification boundary

`gate-compatibility.unit.test.ts` uses explicit relevance fixtures from `gate-cases.json`
and reads each remaining `gate-unique` producer's actual skip expressions. It checks complete direct needs,
success, failure, cancellation, unexpected skips, malformed results, missing lane contracts,
and missing relevance outputs. It also protects PR event visibility, Canary's verified producer
identity, and the existing security and label contexts.

Result artifacts, failure logs, and QA envelopes replace earlier uploads with the same name
on a job rerun. This prevents the merger or report publisher from selecting a previous
attempt's failed receipt after the producer passes. The workflow policy tests cover these
uploads in `test.yml`, `rust-coverage.yml`, and `qa-metrics.yml`; earlier job logs remain
available in the workflow's attempt history.

Local fixtures do not establish hosted behavior. Before cutover, collect current-head API
receipts for ordinary, docs-only, Rust, and release PRs, including failure, cancellation,
unexpected or missing lane cases. Verify the actual API context names after all topology
changes and application `15368` alongside the retained legacy and security contexts. A
reusable workflow's leaf job name alone does not establish its required-check context. An
additive PR that has only run its own workflow-changing case has not completed that hosted
case matrix.

## Stacked pull requests

Use `stack/**` branches as bases for dependent pull requests. CI, Cargo Shim,
Protocol CI, CodeQL and Dependency Review validate PRs targeting that namespace
as well as `main`. Push validation stays limited to `main`, so each stack
commit receives one authoritative PR run. Release Dry Run remains a reusable
CI consumer, and the label workflow retains its unfiltered PR-target event.

A green child PR qualifies its diff against its current parent. Retargeting or
restacking requires fresh validation before landing on `main`; it does not
establish that the earlier parent was merged.

## Protocol compilation and advisory diagnostics

Protocol CI keeps its push path filter and starts for every pull request. Its
changes job exempts only the seven existing Markdown guides under
`docs/protocol/` from the compiled matrix; spec files, contribution instructions,
new guide names, fixtures and other unknown protocol inputs remain relevant.
Root Check still validates documentation, and protocol ownership and local
contribution checks keep their broader path predicate. Manual Protocol CI
qualification always executes the complete matrix, including the TypeScript
check already performed by CI Check on PRs and main pushes.

The per-change `cargo-semver-checks` job is advisory, including setup failures.
It runs outside Protocol Gate's dependencies so diagnostics do not delay the
mandatory path. A failed advisory job remains visible in Actions; every other
Protocol CI lane retains fail-closed aggregate evaluation.
