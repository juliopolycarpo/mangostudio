# CI simplification evidence

Disposition and qualification for [#1851](https://github.com/juliopolycarpo/mangostudio/issues/1851),
recorded on 2026-11-05 UTC. A passing workflow establishes correctness for its
tested source and conditions. It does not establish a performance improvement.

## Disposition

| Item | Decision and scope                                                            | Evidence or remaining qualification                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01  | Promote the selected main CI distribution; preserve main publication bundles. | [#1860](https://github.com/juliopolycarpo/mangostudio/pull/1860) implements promotion; [#1866](https://github.com/juliopolycarpo/mangostudio/pull/1866) fixes equivalent-tree qualification. Canary `0.1.1-canary.c499ad0` was published and recovered after transient visibility failures. Artifact read-back and a registry consumer passed; full no-op recovery remains pending. |
| F02  | Remove the two redundant x64 workspace checks.                                | [#1863](https://github.com/juliopolycarpo/mangostudio/pull/1863); default-feature build, all-target/all-feature Clippy, launcher isolation and Windows ARM64 checks remain. PR/main/dispatch.                                                                                                                                                                                       |
| F03  | Run workspace rustfmt on Ubuntu once.                                         | Same PR; pinned toolchain and mandatory Ubuntu workspace verdict. PR/main/dispatch.                                                                                                                                                                                                                                                                                                 |
| F04  | Restrict nextest installation and inventory comparison to macOS/Windows.      | Same PR; Ubuntu retains the instrumented full libtest run in Rust Coverage. PR/main/dispatch.                                                                                                                                                                                                                                                                                       |
| F05  | Fold fixture freshness into Ubuntu workspace validation.                      | Same PR; ignored regeneration, staged new-file detection, frozen TypeScript tree pins and cache-family retirement are retained. PR/main/dispatch.                                                                                                                                                                                                                                   |
| F06  | Deliver canonical Check evidence to QA.                                       | [#1868](https://github.com/juliopolycarpo/mangostudio/pull/1868); supervised component checkers run once; the report binds source, repository, run, producing attempt and invocation. Missing or interrupted evidence remains unavailable. Hosted Check-to-QA collection passed on the earlier head; the restacked head awaits qualification. PR/main.                              |
| F07  | Share one verified production frontend from the existing Build job.           | [#1869](https://github.com/juliopolycarpo/mangostudio/pull/1869); producer Bun commit, source, lockfile, build environment, build stamp, exact output inventory and metafile are verified. API ESM, production browser assertions and independent clean release preparation remain. Hosted handoff passed before the final restack. PR/main.                                        |
| F08  | Reuse complete verified distribution pairs in PR release dry runs.            | [#1867](https://github.com/juliopolycarpo/mangostudio/pull/1867); original hub/runtime, README and frontend feed packaging/install checks. Clean scheduled/manual shipping qualification remains. The earlier head passed hosted validation; review corrections await current-head checks.                                                                                          |
| F09  | Omit unused aggregate uploads on PRs.                                         | [#1865](https://github.com/juliopolycarpo/mangostudio/pull/1865); target bundles and full packaging/manifest validation remain. Main retains the aggregates consumed by F01.                                                                                                                                                                                                        |
| F10  | Remove only the duplicated PR/main Protocol TypeScript check.                 | [#1864](https://github.com/juliopolycarpo/mangostudio/pull/1864); standalone dispatch, protocol unit tests and published-package verification remain.                                                                                                                                                                                                                               |
| F11  | Require unique aggregate contexts, then retire compatibility jobs.            | [#1870](https://github.com/juliopolycarpo/mangostudio/pull/1870); main ruleset migration was read back with all other rules unchanged. Four surviving producers retain mandatory-needs and relevance/failure contracts; see [gate receipts](ci-gates.md).                                                                                                                           |
| F12  | Exempt seven known prose guides from compiled Protocol CI lanes.              | [#1864](https://github.com/juliopolycarpo/mangostudio/pull/1864); spec, fixtures, contribution policy and unknown protocol paths remain relevant. Root document checks and required verdicts remain. PR/main; dispatch stays complete.                                                                                                                                              |
| F13  | Keep per-change semver feedback advisory outside aggregate dependencies.      | Same PR; setup failure is also advisory to workflow completion. Mandatory Protocol CI lanes remain fail-closed. PR/main/dispatch.                                                                                                                                                                                                                                                   |
| F14  | Defer Bun/Turbo cache policy changes to matched qualification under #1497.    | [#1853](https://github.com/juliopolycarpo/mangostudio/pull/1853) remains an unqualified measurement draft. The new Cargo observations also used different Ubuntu image builds. Frozen installs, trusted writers and profile isolation remain.                                                                                                                                       |
| F15  | Defer current-lane adoption; reject general output-mode equivalence.          | Current ordinary-output Clippy and cargo-hack probes denied warnings. Plain JSON behaved differently, and no reuse benefit was demonstrated. Musl/native parity remains unqualified. PR/main Rust commands remain unchanged.                                                                                                                                                        |
| F16  | Retain deliberate cold cross-runtime qualification.                           | The fresh control spent 15 seconds in the whole job. Its scope change would need a separate qualification argument; preserve PR/main and periodic cold exercise.                                                                                                                                                                                                                    |
| F17  | Retain clean main shipping builds as the publication source.                  | Promotion makes main's shipping artifacts the publication boundary. Keep main lookup-only cache access, PR light identity and the main-only light-cache seed. No global restore-policy change.                                                                                                                                                                                      |
| F18  | Defer schema/interop job consolidation.                                       | Existing parallel jobs retain independent diagnostics. No matched total-work/latency trial has qualified a fold; the short-job cache trial is still inconclusive. PR/main/dispatch topology remains.                                                                                                                                                                                |
| F19  | Defer fuzz target batching.                                                   | Keep six independent targets, 300 seconds each, target input limits, tokio session features and corpus/crash uploads. A batching trial must measure setup savings against serial latency and prove continuation after an earlier failure. No PR fuzz lane is added.                                                                                                                 |
| F20  | Record observations separately from controlled savings.                       | Current samples follow below. Publication and failed-job recovery were observed. Final stack, main-after-landing, scheduled success and repeated-SHA no-op qualification remain pending.                                                                                                                                                                                            |

The fixture cache experiment in #1853 must be reconciled with F05 before adoption:
the standalone fixture producer is retired. Existing physical cache entries are
not evidence of an active writer or of reclaimed storage. #1497 retains cache
inventory and lifecycle ownership; this stack does not claim a physical deletion.

## Observed Actions durations

These are single observations, including every executed job in each named
workflow and excluding skipped jobs. Cumulative job time sums job start/end
intervals; workflow elapsed time runs from `run_started_at` to the last job's
completion and includes scheduling gaps. Neither is a billing estimate. Sibling
workflows are listed separately rather than folded into CI's total.

| Workflow/run                                                                                     | Source         | Event/profile                       | Executed jobs | Cumulative job time | Workflow elapsed |
| ------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------- | ------------: | ------------------: | ---------------: |
| [CI 41950254208](https://github.com/juliopolycarpo/mangostudio/actions/runs/41950254208)         | `aa86dd856d77` | PR, light distribution              |            47 |              80m48s |           16m49s |
| [CI 41950794113](https://github.com/juliopolycarpo/mangostudio/actions/runs/41950794113)         | `b676ebec1d44` | PR, light distribution              |            47 |              79m01s |           16m42s |
| [Cargo Shim 41950253861](https://github.com/juliopolycarpo/mangostudio/actions/runs/41950253861) | `aa86dd856d77` | PR, original x64 checks/fixture job |            11 |              32m22s |           10m16s |
| [Cargo Shim 41950794016](https://github.com/juliopolycarpo/mangostudio/actions/runs/41950794016) | `b676ebec1d44` | PR, F02–F05 candidate               |            10 |              27m31s |            7m39s |

The table records attempt 1 of each run. Additional workflow observations use
the same duration definition, without treating them as matched comparisons:

| Workflow/run                                                                                  | Source         | Event/profile and result                              | Executed jobs | Cumulative job time | Workflow elapsed |
| --------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------- | ------------: | ------------------: | ---------------: |
| [Main CI 41945750819](https://github.com/juliopolycarpo/mangostudio/actions/runs/41945750819) | `c499ad02e79a` | Main push, shipping; success                          |            52 |             114m52s |           20m53s |
| [Canary 41951839028](https://github.com/juliopolycarpo/mangostudio/actions/runs/41951839028)  | `c499ad02e79a` | Manual promotion; approval failure before publication |             3 |               1m41s |            1m49s |

The docs-only control [#1838](https://github.com/juliopolycarpo/mangostudio/pull/1838)
at `d47ad9a3972b` reports all seven migrated required contexts successfully.
[Its CI run](https://github.com/juliopolycarpo/mangostudio/actions/runs/41797118530)
failed on attempt 1 and passed on attempt 2. The rerun's jobs API retains some
prior start/end windows, so its snapshot is not a separate execution-duration
sample. This control qualifies the settings cutover; it predates the stack's
workflow changes.

Both CI runs used the existing two balanced root/API/shared shards and separate
frontend lane, plus Ubuntu Rust Coverage when relevant. Native shipping targets
and smoke coverage were retained; PR runtime artifacts used the light profile.
The workspace Rust version was 1.99.0 in both Cargo runs.

The selected Ubuntu workspace controls restored the same 438,749,658-byte cache
payload, but their images differed:

| Ubuntu workspace                                                                                                  | Image                            | Job duration |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------- | -----------: |
| [Control 126992328819](https://github.com/juliopolycarpo/mangostudio/actions/runs/41950253861/job/126992328819)   | `ubuntu-24.04`, `20261025.353.1` |         193s |
| [Candidate 126994186716](https://github.com/juliopolycarpo/mangostudio/actions/runs/41950794016/job/126994186716) | `ubuntu-24.04`, `20261101.360.1` |         141s |

The control's standalone fixture job took 49 seconds; the candidate ran fixture
regeneration in its workspace job. The measured difference cannot be attributed
to the code changes: runner images, scheduling, other platform caches and the
single-sample design prevent a controlled savings claim.

In CI's control, Check took 56 seconds, QA 72 seconds and cold cross-runtime
qualification 15 seconds. These whole-job observations identify work to inspect;
they do not establish that every setup/cache operation is removable.

Reproduce the duration inventory with the run and complete job APIs, retaining
every page and run attempt:

```bash
gh api repos/juliopolycarpo/mangostudio/actions/runs/41950254208
gh api 'repos/juliopolycarpo/mangostudio/actions/runs/41950254208/jobs?per_page=100' --paginate --slurp
```

## Pinned Clippy warning-policy qualification

The [Clippy recommendation](https://doc.rust-lang.org/clippy/usage.html#elevating-warning-to-errors)
supports `CARGO_BUILD_WARNINGS=deny` from Cargo 1.97. Qualification used Cargo
`1.99.0 (5f94df478)`, rustc/Clippy `b940084d7`, Linux x86_64 and a clean
`c499ad02` checkout. `Cargo.lock` SHA-256 was
`5a005cc53823f64e53bb33d573175231eba0819f5ad408f7230798212e82b25d`.

A dependency-free fixture emitted both an ordinary rustc warning and a Clippy
warning:

```rust
fn unused() {}
pub fn empty(v: &[u8]) -> bool { v.len() == 0 }
```

| Invocation                                                                        | Fresh/cached behavior                                                                        | Exit |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---: |
| `CARGO_BUILD_WARNINGS=deny cargo clippy --message-format=json`                    | Emits `dead_code` and `clippy::len_zero` warnings on both a fresh target and a cached replay |    0 |
| `cargo clippy --message-format=json -- -D warnings`                               | Turns the intended diagnostics into errors after that warning cache                          |  101 |
| `CARGO_BUILD_WARNINGS=deny cargo clippy`                                          | Denies warnings in ordinary output, including cached replay                                  |  101 |
| `CARGO_BUILD_WARNINGS=deny cargo clippy --message-format=json-render-diagnostics` | Denies warnings in rendered JSON mode                                                        |  101 |
| `CARGO_BUILD_WARNINGS=deny cargo hack clippy --feature-powerset`                  | Inner Cargo denies warnings                                                                  |    1 |

Current inspected Clippy commands use ordinary output; the ordinary-output and
cargo-hack probes preserved their warning-denial behavior. The existing
Rust-cost driver requests JSON for `cargo build`, without `-D warnings`; that
driver does not establish a current Clippy regression. The JSON probe disproves
general equivalence across output modes.

A bounded launcher probe recomputed the same two launcher artifacts during
both Clippy transitions and zero during both following checks; it established
no reuse improvement. Concurrent Bun work and subsecond samples leave elapsed
values exploratory. Musl/cargo-zigbuild and native platform parity were not
qualified. Retain the current flags until controlled workspace/wrapper/cache
evidence under #1497 supports a narrower change.

## Frontend and Canary qualification boundaries

[Check CI 41958642029](https://github.com/juliopolycarpo/mangostudio/actions/runs/41958642029)
passed on `6f787fc3`; QA consumed all five component reports with zero findings
and zero tooling failures. A separate
[hosted output probe](https://github.com/juliopolycarpo/mangostudio/actions/runs/41968249733/job/127050258931)
confirmed that failed ordinary and single-job reusable jobs retain their declared
nonsecret outputs. That review claim did not justify adding another verdict job.
The public Protocol check still typechecks; only the internal report companion
omits the component already collected by canonical Check.

[Frontend CI 41960449057](https://github.com/juliopolycarpo/mangostudio/actions/runs/41960449057)
passed on `8846a5b1`, including the production browser, native packaging and QA
handoffs. [Dry-run CI 41958533099](https://github.com/juliopolycarpo/mangostudio/actions/runs/41958533099)
passed on `eda33dee`. These observations precede the final review corrections
and restack; they do not establish current-head readiness.

[The failed final-stack shard](https://github.com/juliopolycarpo/mangostudio/actions/runs/41961144859/job/127030686924)
exposed two test-harness gaps. A healthy retry took 238 seconds against a
240-second attempt limit, and a passing nested fixture leaked its synthetic
failure marker into the outer log. [#1872](https://github.com/juliopolycarpo/mangostudio/pull/1872)
captures that fixture output and permits 480 seconds per numbered-shard attempt
inside an 18-minute job. Two attempts plus a 120-second setup/report reserve fit
the job bound. Real failure retention, shard count, workers, coverage and retry
count remain unchanged; worst-case hang detection increases by four minutes per
attempt.

Fresh reproduction of [#1026](https://github.com/juliopolycarpo/mangostudio/issues/1026)
on `c499ad02` confirmed that a full Turbo cache hit retained an injected
`ZZZ-junk.js`. The candidate clean-before-build route removed it on another
full cache hit, then source/producer/inventory verification passed. This fixes
the CI producer and handoff. #1026 remains open pending hosted QA artifact and
new main-baseline verification. General local cache-hit cleanup is unchanged.

The compiler-cache regression also queries real Turbo task hashes for two
distinct full Bun revisions. The original task reused one hash; the corrected
task produces distinct hashes and repeats the same hash for the same revision.
Both maintained root build entrypoints supply the executing `Bun.revision`
before lookup, overriding inherited markers. A clean-clone build with old cache
entries missed the new compiler-bound key, then hit it on repeat; artifact
record/verify passed. This closes the cached-output attribution gap found during
final review of #1869.

The shipping manifest at `c499ad02` recorded native hub Bun commit
`b1007f1177fd402fae67387b8548cae5ae9b5707` and Alpine hub commit
`b9f2ec36352060f6b976508fa93d54bf8d5d978f`. Consumers therefore verify the
frontend's exact producer Bun commit supplied by its producing job. A hub's
own compiler identity remains separately recorded; consuming browser assets
does not recompile them with that hub compiler.

The [first Canary run](https://github.com/juliopolycarpo/mangostudio/actions/runs/41951839028)
selected successful main CI run `41945750819`, attempt 1, source `c499ad02`.
It failed approval before publication because the authenticated push boundary
`07bd64d3` → `c499ad02` had divergent history with identical root tree
`4461a32f94e40df42edb1a4353f6ce77ad7dcced`. Read-only qualification with
#1866 proves the equal-tree case while retaining all mandatory producer and
existing failed-sibling refusals.

[Canary 41965081765](https://github.com/juliopolycarpo/mangostudio/actions/runs/41965081765)
executed at `2b2c3ab2` and froze the same source CI attempt. Attempt 1 published
all seven npm versions, but immediate read-backs saw them as absent; its GitHub
publisher likewise could not yet observe the draft it had created. Rerunning
failed jobs succeeded on attempt 2 using the original approval bytes.
[The immutable prerelease](https://github.com/juliopolycarpo/mangostudio/releases/tag/v0.1.1-canary.c499ad0)
contains all 22 expected assets, whose streamed sizes and SHA256 values match
the approved distribution. All seven npm versions and `canary` tags read back as
`0.1.1-canary.c499ad0`; npm `latest` and GitHub's stable latest remain `0.1.1`.
A fresh registry install resolved the native Linux package outside the workspace
and its launcher printed the expected version.
All seven registry tarballs passed SRI and cryptographic Sigstore verification
against `canary.yml`, `refs/heads/main` and execution revision `2b2c3ab2`.

The full workflow rerun on attempt 3 stopped in source resolution because its
original Actions snapshot was unavailable. Approval and both publishers were
skipped. Publication metadata, asset IDs/digests and npm tags/integrities were
identical before and after the attempt. This is a fail-closed recovery result,
not a successful complete-version no-op. Recovery using an explicitly pinned
source CI attempt and authenticated original approval remains to be qualified.
