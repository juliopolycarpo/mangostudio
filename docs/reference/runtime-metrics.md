# Runtime Metrics

Size, build-time, and code-volume figures for the cargo-built `mangostudio-runtime`, recorded
when the TypeScript runtime was retired and every distribution target began shipping the Rust
binary. They are a baseline for later changes, not a budget that CI enforces. Re-measure with
the commands below instead of editing numbers by hand.

## Release profile

The workspace `[profile.release]` in the root `Cargo.toml` sets `opt-level = 3`, `lto = "fat"`,
`codegen-units = 1`, `strip = true`, and `panic = "unwind"`. Unwinding is required: handler
panic isolation catches the unwind, so the runtime crate refuses to compile with an aborting
panic strategy.

Local comparison on linux-x64 (`cargo build --release --locked -p mangostudio-runtime`, a
full rebuild each time on a shared 28-thread machine with `CARGO_BUILD_JOBS=8`, so treat the
times as relative):

| Profile                                | Build time | Stripped size | vs. default |
| -------------------------------------- | ---------: | ------------: | ----------: |
| cargo default (thin-local LTO, 16 CGU) |      178 s |      34.08 MB |           — |
| `lto = "thin"`, 1 CGU, strip           |      396 s |      28.89 MB |      −15.2% |
| `lto = "fat"`, 1 CGU, strip (shipped)  |      588 s |      26.26 MB |      −22.9% |

Fat LTO costs about 50% more build time than thin for another 9% of size. The runtime is
built once per release target in CI, so the smaller download wins.

Re-measured on 2026-09-29 at `02aca80f` on the same kind of machine, this time with all cores
(`CARGO_BUILD_JOBS` unset), a clean target directory per build and three interleaved builds per
profile (medians):

| Profile                               | Build time | User CPU | Stripped size | Runtime peak RSS (Δ vs fat) |
| ------------------------------------- | ---------: | -------: | ------------: | --------------------------: |
| `lto = "thin"`, 1 CGU, strip          |      360 s |   1155 s |      28.91 MB |                     +~3 MiB |
| `lto = "fat"`, 1 CGU, strip (shipped) |      491 s |   1045 s |      26.28 MB |                           — |

Thin still builds about 27% faster in wall time (it spends more total CPU, spread across more
parallel codegen), but ships a 10% larger binary and adds about 3 MiB of peak
RSS to every runtime process, with no measurable latency difference. Fat stays: release builds
are rare CI jobs, while size and memory reach every install.

## Binary size per target

`runtime-build.yml` artifacts, uncompressed, both built on the same `feat/rust-runtime` source
(`520a5bea`). Before: that branch's own CI run 36205909878, with cargo's default release
profile. After: CI run 36205927848 for this profile on top of it (head `97c53736`, merge ref
`877d447c`). Build times are the `runtime-build.yml` job durations of those runs, on shared
GitHub-hosted runners.

| Platform           | Before (bytes) | After (bytes) | Change | CI build before | CI build after |
| ------------------ | -------------: | ------------: | -----: | --------------: | -------------: |
| `linux-x64`        |     33,817,680 |    26,031,832 | −23.0% |           4m46s |          7m17s |
| `linux-arm64`      |     30,815,272 |    22,716,960 | −26.3% |           3m43s |          7m22s |
| `linux-x64-musl`   |     32,848,976 |    25,528,488 | −22.3% |           4m46s |          5m17s |
| `linux-arm64-musl` |     29,962,288 |    22,215,192 | −25.9% |           5m01s |          6m38s |
| `darwin-x64`       |     41,646,136 |    24,491,872 | −41.2% |           5m50s |         11m16s |
| `darwin-arm64`     |     40,625,104 |    22,291,904 | −45.1% |           6m04s |          9m27s |
| `windows-x64`      |     40,036,352 |    33,679,872 | −15.9% |           9m27s |         12m23s |
| `windows-arm64`    |     33,780,736 |    28,668,928 | −15.1% |           9m50s |         13m41s |
| **all 8**          |    283,532,544 |   205,625,048 | −27.5% |                 |                |

Linux targets were already stripped before (zig's linker drops symbols), so their change is
LTO and one codegen unit alone. The darwin binaries shrink most because the default profile
left their symbol table in (about 88,000 symbols, against 251 now). A Windows executable
carries no symbol table to strip, so its change is LTO alone. The fat-LTO build adds between
half a minute and five and a half minutes per target, well inside the job's 30-minute timeout.

## What the linux-x64 binary is made of

`CARGO_PROFILE_RELEASE_STRIP=false cargo bloat --release --locked -p mangostudio-runtime --bin mangostudio-runtime --crates -n 20`
on the shipped profile, at the `72172b38` runtime source. The `.text` section is 18.8 MiB of a
34.3 MiB unstripped file; attribution under fat LTO is approximate.

| Crate                   | `.text` share |      Size |
| ----------------------- | ------------: | --------: |
| `mangostudio_runtime`   |         15.8% |   3.0 MiB |
| `std`                   |         13.5% |   2.5 MiB |
| `jsonschema`            |         12.9% |   2.4 MiB |
| `tokio`                 |          7.4% |   1.4 MiB |
| `serde_core`            |          4.7% | 912.9 KiB |
| unattributed            |          4.6% | 891.3 KiB |
| `rmcp`                  |          4.1% | 795.1 KiB |
| `mango_protocol`        |          3.6% | 701.3 KiB |
| `serde_json`            |          3.6% | 691.4 KiB |
| `mango_agent_codex`     |          3.5% | 667.8 KiB |
| `mango_agent_acp`       |          2.4% | 467.5 KiB |
| `mango_external_agents` |          2.1% | 394.4 KiB |
| `rustls`                |          2.0% | 381.8 KiB |
| 109 more crates         |         18.8% |   3.5 MiB |

`cargo machete` and `cargo +nightly udeps --workspace --all-targets --all-features` report no
unused dependency, and `tokio` enables only the features the runtime calls.

## Code volume of the Rust migration

`git diff -M50% --numstat origin/main...46785f6f` (the `feat/rust-runtime` tip this baseline was
recorded on), classified by path:

- **docs**: `docs/**` and any `*.md`.
- **generated**: paths under `generated/`, `Cargo.lock`, `bun.lock`.
- **tests**: `tests/`, `fixtures/`, `examples/`, `fuzz/` directories, `*.test.ts(x)`, and Rust
  `tests.rs`/`*_tests.rs`/`testing.rs` files. **Rust (inline modules)** counts the lines of
  `#[cfg(test)] mod … { }` blocks inside Rust source files and removes them from production.
- **production**: everything else. TS means `.ts`/`.tsx`/`.js`; other means JSON, YAML, TOML,
  shell, and the rest.

| Kind           | Language              | Files |  Added | Deleted |     Net |
| -------------- | --------------------- | ----: | -----: | ------: | ------: |
| production     | TypeScript            |   891 |  5,791 |  40,631 | −34,840 |
| production     | Rust                  |   182 | 65,338 |      25 | +65,313 |
| production     | other                 |    39 |    918 |     456 |    +462 |
| tests          | TypeScript            |   270 | 19,939 |  29,216 |  −9,277 |
| tests          | Rust (test files)     |    50 | 23,545 |      16 | +23,529 |
| tests          | Rust (inline modules) |   134 | 34,067 |       0 | +34,067 |
| tests          | other                 |    20 |  4,401 |     177 |  +4,224 |
| docs           | Markdown              |    40 |  1,847 |     494 |  +1,353 |
| generated      | other                 |     8 | 25,217 |     245 | +24,972 |
| **production** | all                   |       | 72,047 |  41,112 | +30,935 |
| **tests**      | all                   |       | 81,952 |  29,409 | +52,543 |
| **docs**       | all                   |       |  1,847 |     494 |  +1,353 |
| **generated**  | all                   |       | 25,217 |     245 | +24,972 |

The inline-module row re-counts lines of production Rust files, so its file count overlaps the
production Rust row; its lines are subtracted there. One binary file is not counted.

The TypeScript runtime's removal is most of the production TS deletions; its behaviour moved
into the Rust production lines, and its compatibility coverage into Rust tests and frozen
fixtures.

## Hub binary: bytecode

The hub is not a cargo build, but it ships beside the runtime, so its startup and size are
recorded here too. `scripts/build.ts` compiles it with `--bytecode --format=esm` (bytecode
alone emits CommonJS, which rejects the entry's top-level `await`). JSC then loads
precompiled bytecode instead of parsing the minified bundle on every start.

Measured on linux-x64 with Bun 1.4.2, on `7d7263d6` with and without the two flags, both from
`bun run build:binary --platform linux-x64` (production, embedded frontend). Startup is the
median of 15 runs of `scripts/bench/startup.ts`; `--version` is the median of 20 runs.

| Measure                    | Without bytecode | With bytecode | Change |
| -------------------------- | ---------------: | ------------: | -----: |
| `--version`                |           427 ms |        148 ms |   −65% |
| Cold start → `/api/health` |           908 ms |        406 ms |   −55% |
| Warm start → `/api/health` |           803 ms |        356 ms |   −56% |
| Peak RSS during startup    |           123 MB |        129 MB |    +5% |
| Binary size (bytes)        |       99,218,912 |   116,930,016 |   +18% |

Every target grows by the same ~17.7 MB of bytecode (`bun build --compile` of the same embed
entry for the other seven targets). The external `.map` is unchanged in shape, and stack
traces still resolve to original source lines.

## Build and validation baseline, 2026-10-08

These observations use implementation source
`9693ac5e336d0681dc6753c1fbda400dbe1f7a6d`. The documentation and help test added
afterward have a separate qualification source; that new root test is excluded
from the measured case counts below. These are final-source observations, not
before/after deltas against the historical measurements above.

### Environment and measurement scope

The host was linux-x64 under WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`,
with an Intel Xeon E5-2699 v3 at 2.30 GHz, 34 logical CPUs and 49.776 GiB of
visible memory. Worktrees and dedicated Cargo targets were on the same real-disk
ext4 mount (`/dev/sdc`, device `8:32`, mount `/`). Tools were rustc/Cargo 1.99.0,
Bun 1.4.2, Turbo 2.11.7, TypeScript 7.0.2, cargo-nextest 0.9.144 and cargo-hack
0.6.45. Compilation overrides were cleared.

Each producer held the shared host lock through process settlement. Runtime
builds ran in private Linux user, PID and mount namespaces with a private proc
mount; namespace UID/GID 0 mapped to host UID/GID 1000. A waiting launcher
forwarded signals and required the driver's terminal acknowledgment and empty
process census before namespace exit. Worktree, target, cache and lock mounts
retained their host filesystem identities. CPU resources were shared; these
measurements do not qualify native Windows/macOS performance or hosted CI.

Wall, user CPU and system CPU are seconds. RSS is GNU time's per-process maximum
in MiB, not summed process-tree memory or the runtime's startup RSS. Multi-sample
rows show independently calculated medians in each column and the wall range.
Queue time is excluded. Registry and toolchain caches were retained; the OS
page cache was uncontrolled.

### Runtime builds

Both profiles used normal default features and their own initially empty target:

```bash
cargo build --locked -v -p mangostudio-runtime --bin mangostudio-runtime
cargo build --locked -v -p mangostudio-runtime --bin mangostudio-runtime --release
```

The dev profile retained line-table debug information for workspace code and
disabled dependency debug information. Release retained fat LTO, one codegen
unit, stripping and unwinding, as described above. All 16 build cells exited 0.

| Profile | Change         | Samples | Wall median (range) | User CPU | System CPU | Max RSS (MiB) | Library/binary rustc starts |
| ------- | -------------- | ------: | ------------------: | -------: | ---------: | ------------: | --------------------------: |
| dev     | Cold target    |       1 |               72.54 |   351.55 |      47.53 |       1774.41 |                         1/1 |
| dev     | Unchanged      |       3 |    0.37 (0.34–0.37) |     0.26 |       0.11 |         78.14 |                         0/0 |
| dev     | Version stamp  |       3 |    2.06 (2.03–2.18) |     2.55 |       1.65 |        829.84 |                         0/1 |
| dev     | CLI usage edit |       3 |    7.90 (7.69–8.20) |     7.09 |       2.86 |       1048.83 |                         1/1 |
| release | Cold target    |       1 |              477.91 |   989.06 |      51.63 |       2103.46 |                         1/1 |
| release | Unchanged      |       3 |    0.34 (0.33–0.44) |     0.23 |       0.13 |         77.96 |                         0/0 |
| release | Version stamp  |       1 |              254.31 |   249.55 |       4.68 |       2103.12 |                         0/1 |
| release | CLI usage edit |       1 |              401.84 |   393.57 |       8.44 |       2105.05 |                         1/1 |

Stamp cells changed only `MANGOSTUDIO_RELEASE_VERSION` to a distinct valid canary
version and checked the resulting `--version`. The library rlib's path, bytes
and mtime remained unchanged. The release stamp still took 254.31 seconds:
reusing the library leaves substantial binary compilation and linking work
under fat LTO and one codegen unit.

CLI edit cells changed real usage text in the library's `cli.rs`, rebuilt both
library and binary, and asserted the new marker in `--help`. Original source
bytes and mtimes were restored after settlement. The driver retains the help
assertion result; each cell's help stdout was not separately archived. These
controlled benchmark artifacts are ineligible for shipping or validation reuse.

### Repository gates

All 20 declared validation producers exited 0. Runtime-backed tests used
immutable default runtime and fake-agent copies qualified against all 390 build
inputs, toolchain, normal feature graph and checksums. The runtime and fake were
built in separate Cargo invocations; all-features Rust gates used a separate
writable target.

| Command or gate                                             | Samples | Wall median (range) | User CPU | System CPU | Max RSS (MiB) |
| ----------------------------------------------------------- | ------: | ------------------: | -------: | ---------: | ------------: |
| `bun run protocol:check`, cold target                       |       1 |             134.934 |   718.30 |     100.45 |        400.01 |
| `bun run protocol:check`, retained target                   |       3 | 6.629 (6.463–6.994) |    11.17 |       5.08 |        117.56 |
| `bun run protocol:test`                                     |       1 |              77.969 |   247.92 |      32.03 |        753.81 |
| `bunx --no-install turbo run typecheck --force --ui=stream` |       3 | 9.648 (9.388–9.937) |   102.45 |      14.57 |       2402.55 |
| `bun run check`, prime                                      |       1 |              19.549 |   151.96 |      15.05 |        757.55 |
| `bun run check`, warm                                       |       3 | 9.161 (8.785–9.245) |    66.34 |      10.41 |        758.17 |
| `bun run test`, empty Turbo cache                           |       1 |             197.594 |   774.24 |     157.33 |       1468.64 |
| Rust format                                                 |       1 |               2.030 |     1.89 |       0.13 |        117.54 |
| Rust Clippy                                                 |       1 |              58.642 |   206.00 |      27.45 |       1507.09 |
| Rust nextest                                                |       1 |             133.518 |   627.31 |      87.38 |       3208.35 |
| Rust doctests                                               |       1 |              21.383 |    21.45 |       5.11 |        855.12 |
| Rust docs                                                   |       1 |              27.741 |    53.54 |       5.65 |        822.54 |
| `bun run verify`, serial coverage                           |       1 |             554.850 |   889.66 |     196.98 |       1465.45 |
| `bun run protocol:test --ts-only`, separate complement      |       1 |               6.591 |     4.85 |       1.93 |        252.19 |

The five Rust rows use the exact commands in
[Rust Workspace Tests](./testing.md#rust-workspace-tests), including all-targets,
all-features, locked dependencies, warnings denied and nextest `--retries 0`.
Nextest passed 2,313 tests and skipped 24; workspace doctests passed 291 and
ignored 192, with zero failures. Those times include compilation. Full protocol
testing passed 628 TypeScript cases, including all 12 Rust interop cases; its
Rust target and doctest groups passed 508 cases with one ignored.

Full protocol checks passed all 13 tasks on every observation. Protocol Turbo
tasks were 0/2 cached cold and 2/2 cached with a retained target; Cargo and
roundtrip work still ran. Every forced typecheck executed all four workspaces
with 0/4 cached. The separate check prime had 4/10 general tasks and 2/2 protocol
tasks cached; each warm check had all 10/10 and 2/2 cached.

The empty-cache full test had no cached test tasks and used the delivered
defaults: four root workers, six API unit workers and four API integration
workers. It passed 13,567 cases, skipped 48 and failed zero. Serial `verify`
ran check, coverage and `build --all`: check hit 12/12 tasks, coverage hit 0/1
root and 0/3 workspace tasks, and build hit 0/3. It passed 12,951 cases and
skipped 36. The separate TypeScript protocol complement passed 616 and skipped
12, bringing the combined census to the plain test's 13,567 passes and 48 skips.
`verify` alone therefore does not cover the complete protocol gate.

Plain worker reports and serial coverage reports matched the exact file,
class name, case name and outcome multiset for root (187 files, 2,690 cases),
API unit (428 files, 5,231 cases) and API integration (131 files, 1,160 cases).
Frontend coverage was 86.32% lines, 79.94% functions, 83.38% statements and
55.16% branches, above the respective 81%, 76%, 81% and 53% floors. These are
frontend values, not aggregate workspace coverage.

## Re-measuring

- Sizes: download the `runtime-<sha>-<platform>` artifacts of a CI run
  (`gh run download <run-id> -p 'runtime-*'`) and compare file sizes.
- Composition: the `cargo bloat` command above, on Linux x64.
- Code volume: the `git diff` above against the current `origin/main`.
- Hub startup: `bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio --runs 15`
  (add `--warm` for a restart) against binaries built with and without the flags.

## Requalifying the current baseline

The figures above describe their recorded revisions. They do not qualify a later dependency graph,
compiler or artifact. Keep the shipping profile unchanged when measuring a new baseline; there is no
optimization candidate in the following schedule.

```bash
# Read-only schedule: no compilation or startup trial.
bun scripts/bench/rust-costs.ts
# Run only on an otherwise idle host, from a clean committed checkout.
bun scripts/bench/rust-costs.ts --execute --out /tmp/rust-cost-receipts \
  --attribution --startup-hub /path/to/current/compiled/mangostudio
```

The fixed build workload is three empty-target releases for each of the runtime and launcher,
followed by ten runtime no-op builds and ten version-restamp builds. No-op and restamp are separate
workloads, not an optimization comparison. Builds use eight jobs, the locked default-feature graph
and the explicit `x86_64-unknown-linux-gnu` target. Targets stay inside this worktree on ext4. Registry,
toolchain and OS page caches remain populated. A fresh receipt directory prevents overwriting failed
attempts. Disk allocation is checked between attempts against a 40 GiB target/artifact budget, with
a three-hour batch deadline; keep additional disk headroom for an individual build.

Receipts include the source head and Rust/Cargo input seal, toolchain, all-target dependency tree,
stable default/all-feature metadata and the excluded fuzz graph. Every accepted build must exit
successfully with a settled process tree and unchanged inputs. No-op builds require no new compiler
artifact and an unchanged executable hash. Restamps require one rebuilt compiler unit, the expected
version, a changed executable hash and unchanged library hashes. Only the runtime has a restamp workload: its existing `MANGOSTUDIO_RELEASE_VERSION` compile-time input changes the embedded version. The launcher uses Cargo package metadata and has no restamp workload. The downloader launcher is never executed for identity: its version comes from the sealed Cargo package metadata, so inspection cannot install a hub or read the user’s runtime state. All attempts and raw logs remain available if a later attempt
fails. GNU-time elapsed seconds (10 ms print resolution), final user/system CPU and maximum individual-process RSS are separate from the
sampled process-tree RSS/CPU observations.

`--attribution` builds a separate unstripped host artifact for `cargo bloat`. Symbol attribution is
qualified only when its `.text` SHA-256 equals the measured stripped artifact's `.text` SHA-256. A
mismatch stays explicitly unqualified. The host GNU baseline does not attribute a different Zig-built
distribution binary, even if both came from the same source. Artifact receipts retain file bytes,
section bytes, ELF metadata and both file/code hashes.

With `--startup-hub`, the driver also runs the existing protocol and HTTP startup scripts under its
process supervisor: two labeled warmups and twenty measured attempts for runtime hello plus first
health response, hub with a fresh database, and hub with a retained migrated database. The hub binary
must have its own current-source build receipt. Standalone commands are also available:

```bash
bun scripts/bench/runtime-handshake.ts /path/to/runtime --runs 20 --warmups 2 \
  --resources --json --output runtime-readiness.json
bun scripts/bench/startup.ts /path/to/hub --runs 20 --warmups 2 \
  --resources --json --output hub-fresh-readiness.json
bun scripts/bench/startup.ts /path/to/hub --runs 20 --warmups 2 --warm \
  --resources --json --output hub-migrated-readiness.json
```

Startup scripts retain warmups, successes and failures and stop the batch on failure. With `--output`, they sync a start/finish JSONL journal (override with `--journal`) and atomically checkpoint completed attempts, so an outer timeout preserves earlier samples and identifies the interrupted attempt. The driver always enables these paths. Without an output/journal path, standalone JSON appears only on normal completion. They isolate
`HOME`, `USERPROFILE` and application state; HTTP readiness also requires this child's persisted pid,
port and fresh start time. `--resources` uses Linux procfs, records the sampling interval, CPU ticks,
page units and cleanup census, and leaves missing observations unavailable. Resource frames are bounded by the actual readiness timestamp, not the later census completion; a sample with no pre-readiness observations stays unqualified with null metrics. RSS is the largest
contemporaneous sum of observed processes, counting shared pages once per process. CPU ticks are
sampled: zero observed ticks does not mean zero actual CPU cost. The recorded checkout is the harness
checkout; the executable hash must be linked to its separate build receipt. WSL measurements qualify
that host only; native Windows and macOS remain unperformed until separately measured.

The build driver handles SIGINT/SIGTERM by canceling the active supervised command, settling its
verified process scope, journaling the interrupted attempt and stopping the batch. External hard
timeouts still need an outer process supervisor: SIGKILL cannot run cleanup inside the killed process.

The locked metadata commands use an explicit machine-stdout limit of 8 MiB per UTF-8 line, with a
16 MiB hard ceiling. This preserves complete compact Cargo JSON without changing the default text
reporter or stderr bounds. Exceeding the selected bound remains a command error; raw stdout is retained.

The first admission attempt at `5e267450` produced valid Cargo metadata with 329 packages and
1,691,503 raw bytes, but the generic 1 MiB text-reporting guard rejected that line after Cargo exited
successfully. The batch stopped before any build, warmup or readiness attempt. No timing or resource
sample was accepted, and all later workloads remained unperformed. The failed admission is retained;
a subsequent study uses a new label and must pass its own source, correctness and cleanup gates.

## Controlled Rust baseline, 2026-10-23

Measured source is `6cf4602a1a98c32536b5a8b83e6a40361198f657`, with executable-input seal
`b72a43ad1883b85b9d6074f3cebc4f78fe9c4861718aa2abfee58650fe2451ae`.
This results publication and its policy test are later changes; they do not relabel the measured source.
The exclusive Linux study ran on 2026-10-23 under WSL2, kernel
`6.18.54.1-microsoft-standard-WSL2-polycarpo`, Intel Xeon E5-2699 v3 2.30 GHz,
28 logical CPUs and 49,326,686,208 visible memory bytes. Cgroup CPU/memory limits were unavailable,
not reported as zero or unlimited. Native Windows/macOS performance and hosted CI cost remain unmeasured.

Rust/Cargo were 1.99.0 (`b940084d7` / `5f94df478`), LLVM 23.1.1, Bun 1.4.3 and cargo-bloat 0.12.1.
The GNU cohort used `x86_64-unknown-linux-gnu`, eight jobs, default features and the unchanged
opt-level 3 / fat LTO / one codegen unit / stripped / unwind release profile, with
`CARGO_INCREMENTAL=0`. The locked inventories contained 329 default packages, 331 all-feature
packages and 101 excluded-fuzz packages. Registry/toolchain caches were prefetched and retained;
Cargo ran offline. Each clean trial had a private empty ext4 target. Runtime target 3 was retained
for alternating no-op/restamp attempts. OS page cache stayed uncontrolled and warm; fresh target,
process or database does not establish machine-cold behavior.

| Locked input             | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Root Cargo.lock          | `3dfa76f2a871b523de34fc7875198e0dd16279b7d511cdeab4905c1b70f9bd59` |
| Excluded fuzz Cargo.lock | `f64f889d768cf0e0c1b6e394bb1491cbd7f331a9423834ab5f3c93a70354293e` |
| bun.lock                 | `acf1b4fdd7e3e268050bc0c465cf3cab736a723685ebccf109379b69d5f5bb77` |

The compiled Bun hub H was built and passed the official compiled smoke at
`d9becbeec8963097ba9a485ce101f92c43a4abef`. Its packaged sidecar Z is the separately built
Zig/glibc-2.17 runtime (Rust inputs unchanged since `911c476c`). Application, Rust, locks and production
build inputs were verified equal at the measured source; benchmark/capture helpers intentionally
changed after hub setup. H+Z startup is separate from the GNU build/runtime cohort. The hub can start runtime
children before health; sampled descendants are included. The Rust downloader
launcher L0 was built three times and never executed. Its version was sealed from Cargo metadata.

### Build and readiness observations

The order was three runtime clean builds, three launcher clean builds, then ten alternating
runtime no-op/restamp pairs. All 26 passed. Every no-op rebuilt zero units and preserved the
executable hash; every restamp rebuilt one unit, changed the executable hash, kept nonempty library
hashes identical and returned the exact `0.1.1-bench.1` through `.10` version. No optimization candidate
exists, so these distinct workloads establish no savings delta.

| Workload                 |  n |   Min s | Median s |   p95 s |   Max s | Spread s | Median final CPU user/system s | Median sampled tree RSS MiB |
| ------------------------ | -: | ------: | -------: | ------: | ------: | -------: | -----------------------------: | --------------------------: |
| Runtime, empty target    |  3 | 471.520 |  471.980 |       — | 473.020 |    1.500 |               854.690 / 36.470 |                    4405.098 |
| Launcher, empty target   |  3 |  44.350 |   44.610 |       — |  44.740 |    0.390 |                 70.170 / 5.390 |                    1254.852 |
| Runtime, no-op           | 10 |   0.360 |    0.390 |   0.430 |   0.430 |    0.070 |                  0.235 / 0.110 |                      75.512 |
| Runtime, version restamp | 10 | 233.110 |  234.510 | 238.750 | 238.750 |    5.640 |                230.640 / 4.085 |                    2150.988 |

After an unscored attribution build, runtime hello/health, fresh-DB hub health and migrated-DB hub
health each ran two retained warmups followed by twenty measured attempts. All 66 attempts succeeded;
the six warmups are excluded from summaries and retained below. Runtime negotiated hello had
min/median/p95/max/spread 174.824 / 193.737 / 213.288 / 214.148 / 39.324 ms (n=20).

| Useful endpoint                |  n |  Min ms | Median ms |  p95 ms |  Max ms | Spread ms | Median sampled CPU user/system ms | Median sampled tree RSS MiB |
| ------------------------------ | -: | ------: | --------: | ------: | ------: | --------: | --------------------------------: | --------------------------: |
| GNU runtime hello + health     | 20 | 305.877 |   325.993 | 345.907 | 352.488 |    46.612 |                          150 / 85 |                      67.033 |
| Hub + Zig runtime, fresh DB    | 20 | 360.742 |   419.285 | 439.980 | 446.751 |    86.008 |                         635 / 150 |                     111.791 |
| Hub + Zig runtime, migrated DB | 20 | 286.377 |   349.174 | 358.860 | 365.151 |    78.774 |                         540 / 130 |                     109.400 |

Each table column is summarized independently. Percentiles use nearest rank (rank 10 of 10 or
19 of 20); three clean builds provide no stable tail estimate, so their p95 is omitted.
GNU-time build elapsed/final CPU has 10 ms print resolution. Its maximum individual-process RSS
is separately retained in KiB below. Tree RSS is the maximum contemporaneous observed sum, sampled
every 20 ms for builds and 10 ms for startup. Procfs used 4096-byte pages and 100 CPU ticks/s
(10 ms CPU resolution). Shared pages count in each process; these sums are not unique physical RAM.
Sampled CPU can miss exited work; zero observed ticks is not zero actual CPU. Missing values stay
blank in CSV, distinct from zero. Every startup sample had at least 28 pre-readiness observations.
The exporter independently recomputed all startup RSS/CPU/count summaries from those frames.

The study additionally requires zero historical census failures, even when a later successful census
lets the generic command runner report terminal settlement with `errors=[]` and an empty scope.
This stricter admission policy was already active in the measured source; its new named predicate
and regression make that distinction explicit. Generic runner recovery remains unchanged.
A census completed after readiness stays excluded from readiness resource totals; backdating its
values would include post-event work. With no completed pre-readiness census, costs stay null and the
attempt is unqualified even when raw journals retain hello/health timestamps. Latency-only qualification
is not part of this study.

### Artifacts and retained dispositions

The GNU runtime used for readiness is R12, version `0.1.1-bench.10`. R0/R1/R2 are the three clean
runtime artifacts; subsequent runtime IDs follow restamp order. All launcher builds produced L0.
H+Z denotes the compiled hub with its Zig sidecar. Empty text fields for H/Z mean uncollected section
identity, not zero bytes. S is the separately built unstripped GNU symbol artifact.

<details>
<summary>Artifact identities (CSV)</summary>

```csv
artifact_id,kind,version,file_bytes,text_bytes,file_sha256,text_sha256
R0,runtime,0.1.1,26433712,19822405,7777e6fe212ce80a49bca899543cff4b4f9437e470a13276939169afdab58838,2723a7a7e12151a70d21dddf4bb79a4617d6dc20554502b8e0a5184a6bdeca61
R1,runtime,0.1.1,26433712,19822405,c640a23c6e70a77594d22be72204d680f81e9d5d759239100be3a293a2f70d2e,beb616b9831494f9152417116eaa4306b5d7a4869a411a49649c2a670aeeadb3
R2,runtime,0.1.1,26433712,19822405,8df45395cb6af753ccac9b2679893da070c7d442f54d502eeddf3e8a50a4b71c,94891509d06980b8ef9d23d03f9e250ed520082e103120d6808242afbf8a8043
L0,launcher,0.1.1,2223128,1570246,afd2a4fa9bd6e9305aa05409c4eaa483bbe2d03b5169ce501a17f282bab6f1d7,2b32b9c9405a8f80edae61b875030b3d43464b3538b395543f67e03d364420be
R3,runtime,0.1.1-bench.1,26433776,19822469,3c9d97c4ec2ed7fb8180cdf02247e7f34ac1a2c36877d701bdcd6728d77d6b1e,19c1d158b6fcd0b77c168914ba5e65a2ae6d29d4843d78679e290f9e1b581cd5
R4,runtime,0.1.1-bench.2,26433776,19822469,213f469e7f4fd96d2311e93acde57b206f847af123270709f1b7741fe89a8966,3a64ceee9f2bedeebb73802c6caac1ffcb4e23be67373c14123aa42e99da792b
R5,runtime,0.1.1-bench.3,26433776,19822469,84031a18fc7085991403b3530a64dfed645c02c01c080438213c3b4fd48347d8,9299be76f6778f263408483b897e8aca43cdd9a4192ecbe59e7fc7f160a19b18
R6,runtime,0.1.1-bench.4,26433776,19822469,79c4a51976fcb5b849a76cd02cfe2359178c755d6615b0cca62a76d88ad5d7b1,6d8a71a50c7cdf87ca16fe24b040c2868cb33b71f0caa6ae8cda92b94a4b2ef7
R7,runtime,0.1.1-bench.5,26433776,19822469,6ec6653befa8b86ed82c0128b74181c9cd1578165f659776a567fbe444a4a31d,612530561d854012e9fe1ffa7e962dc6fb1628b19b6f9a0d16955d4215c21c17
R8,runtime,0.1.1-bench.6,26433776,19822469,a7de7be80f0d9e565be3aa580aa2aa30b927da9c830b3d25b273685d67b030ff,5f34df99b04df8334b4e713232075134cde1c35b4b7ceb9c9d17db52de67bea9
R9,runtime,0.1.1-bench.7,26433776,19822469,c01174c0ee87177accf1dae17078246e9be0ceeb0a15be727a94b0f712dc9630,301ce577d91022548e516690a1326d1df9ed5a46bf2359545b22a9377571c555
R10,runtime,0.1.1-bench.8,26433776,19822469,70a9d3c507bac3ded8e979d45fcd173f9a0e533953fccc3a5a767f837979549e,f625d7922986b8ea7f1120202478eb2850c288f40f886d4274efd83656467e47
R11,runtime,0.1.1-bench.9,26433776,19822469,40f8054a56d8eeb03bf74aa0ed7d6749b7c2dce0f1564b1ec6ac02858c780a8c,ac1cecf491d802ba331f2159188f3a35589ecc42607c31236b9782372211cf9d
R12,runtime,0.1.1-bench.10,26433776,19822469,86d79b93e822d09912ae07dcd3785ab4825296aaa0cc56280f065fcaba47eaba,395139e727727e3a51303eb3aac411e24c3baf602e677a2176a12276e2f74d9e
H,compiled-hub,0.1.1,127743968,,1b82f44b99a6dc4c48a692819cfa54aa299dcaab6558f8912701fbcdd38ded1d,
Z,zig-runtime,0.1.1,26182344,,ce2c17835cf6736468aef01d185e74613fec91f43835a267b68a12892fb52bc3,
S,unstripped-gnu-runtime,0.1.1-bench.10,36120128,19820101,24ead16b32f7b246564818aac43473594838093dd9272c670bd8902bb87f3083,e8770368558c0159c7a80945d64283ab99fea66db62004c4aaade7f6165488fd
```

</details>

Attribution S was retained unqualified: its `.text` SHA-256
`e8770368558c0159c7a80945d64283ab99fea66db62004c4aaade7f6165488fd` differs from R12's
`395139e727727e3a51303eb3aac411e24c3baf602e677a2176a12276e2f74d9e`.
No dependency breakdown is accepted for R12 or Z. No retry replaced this outcome.

The earlier v1 admission at `5e267450` retained its 1,691,503-byte, 329-package metadata payload and
its text-limit rejection; zero build/startup samples ran, and all 26 builds, attribution and 66
startup attempts remained unperformed in that batch. V2 uses its own label and includes all 92 build/
startup attempts without retry, plus the unqualified attribution row. No failed sample was relabeled.
Functional setup and fixture tests are unscored. Native Windows/macOS remain unperformed.

The three-hour reservation used TERM at 10,755 s, 30 s escalation and 15 s settlement reserve.
The 40 GiB allocation gate ran between attempts, not as a hard mid-build quota. The largest recorded
build boundary was 2,280,787,968 bytes; setup separately used 564,727,808 bytes. Every command ended
without error or historical poll failure and with an empty scope: 138 command receipts, 2,470 observed
owned process identities and zero final survivors. Final source/input/tool/H/Z seals matched.

<details>
<summary>All attempts and raw numeric samples (CSV)</summary>

Times are milliseconds; bytes and KiB are named explicitly. `phase=warmup` rows are retained,
`valid=false` rows have no accepted performance values, and empty numeric fields are unavailable.
Runtime `hello_ms` and `ready_ms` share the launch origin; hub `ready_ms` ends at HTTP health.

```csv
attempt,scenario,phase,status,valid,build_elapsed_ms,final_user_cpu_ms,final_system_cpu_ms,max_individual_rss_kib,spawn_ms,hello_ms,ready_ms,peak_sampled_tree_rss_bytes,sampled_user_cpu_ms,sampled_system_cpu_ms,observed_process_count,resource_sample_count,artifact_id,failure_code,disposition
v1-metadata-default,admission,unscored,rejected,false,,,,,,,,,,,,,,TEXT_LINE_LIMIT,zero_build_or_startup_trials
runtime-empty-1,runtime-empty,measured,completed,true,471520,853360.00,38340.00,2133896,,,,4619079680,849510,33340,537,20045,R0,,
runtime-empty-2,runtime-empty,measured,completed,true,473020,854950.00,36470.00,2133488,,,,4626513920,850870,31080,546,20001,R1,,
runtime-empty-3,runtime-empty,measured,completed,true,471980,854690.00,35950.00,2132668,,,,4614483968,850930,30630,558,19963,R2,,
launcher-empty-1,launcher-empty,measured,completed,true,44610,69590.00,5390.00,426524,,,,1315807232,68270,4160,161,1913,L0,,
launcher-empty-2,launcher-empty,measured,completed,true,44350,70170.00,5480.00,426548,,,,1294999552,68900,4120,160,1911,L0,,
launcher-empty-3,launcher-empty,measured,completed,true,44740,70260.00,5210.00,426792,,,,1315934208,69000,3950,161,1920,L0,,
runtime-noop-1,runtime-noop,measured,completed,true,380,220.00,130.00,77512,,,,79372288,210,120,1,16,R2,,
runtime-restamp-1,runtime-restamp,measured,completed,true,234360,230430.00,3900.0,2132840,,,,2254336000,230420,3870,5,10198,R3,,
runtime-noop-2,runtime-noop,measured,completed,true,430,280.00,100.0,77316,,,,79171584,270,100,1,18,R3,,
runtime-restamp-2,runtime-restamp,measured,completed,true,236540,232560.00,3930.00,2131820,,,,2261032960,232540,3880,5,10283,R4,,
runtime-noop-3,runtime-noop,measured,completed,true,410,280.00,100.0,77332,,,,79187968,280,90,1,18,R4,,
runtime-restamp-3,runtime-restamp,measured,completed,true,235870,231780.00,4110.00,2133908,,,,2248216576,231760,4050,5,10324,R5,,
runtime-noop-4,runtime-noop,measured,completed,true,360,210.00,110.00,77360,,,,78954496,210,100,1,15,R5,,
runtime-restamp-4,runtime-restamp,measured,completed,true,233110,228850.00,4250.00,2133592,,,,2255548416,228820,4170,5,10172,R6,,
runtime-noop-5,runtime-noop,measured,completed,true,390,260.00,110.00,77512,,,,79110144,260,110,1,17,R6,,
runtime-restamp-5,runtime-restamp,measured,completed,true,233730,229680.00,4060.00,2132800,,,,2250551296,229660,4020,5,10183,R7,,
runtime-noop-6,runtime-noop,measured,completed,true,400,250.00,110.00,77212,,,,78798848,250,100,1,18,R7,,
runtime-restamp-6,runtime-restamp,measured,completed,true,233990,229780.00,4180.00,2133436,,,,2263916544,229750,4140,5,10178,R8,,
runtime-noop-7,runtime-noop,measured,completed,true,380,230.00,120.00,77464,,,,79323136,230,110,1,17,R8,,
runtime-restamp-7,runtime-restamp,measured,completed,true,233540,229650.00,3900.0,2133600,,,,2250235904,229650,3850,5,10144,R9,,
runtime-noop-8,runtime-noop,measured,completed,true,380,240.00,110.00,77556,,,,79417344,240,100,1,17,R9,,
runtime-restamp-8,runtime-restamp,measured,completed,true,237260,232920.00,4340.00,2133936,,,,2255400960,232920,4300,5,10292,R10,,
runtime-noop-9,runtime-noop,measured,completed,true,390,200.0,150.00,77852,,,,79458304,200,140,1,17,R10,,
runtime-restamp-9,runtime-restamp,measured,completed,true,238750,234640.00,4140.00,2133600,,,,2259374080,234610,4110,5,10343,R11,,
runtime-noop-10,runtime-noop,measured,completed,true,400,210.00,150.00,77180,,,,79032320,210,140,1,18,R11,,
runtime-restamp-10,runtime-restamp,measured,completed,true,234660,230850.00,3830.00,2134132,,,,2264276992,230800,3800,5,10208,R12,,
v2-attribution,attribution,unscored,completed,false,,,,,,,,,,,,,S,TEXT_HASH_MISMATCH,no_accepted_dependency_breakdown
runtime-readiness-warmup-1,runtime-readiness,warmup,success,true,,,,,6.2366009999999505,200.79503499999998,318.54725499999995,70750208,150,90,6,30,R12,,excluded_warmup
runtime-readiness-warmup-2,runtime-readiness,warmup,success,true,,,,,1.1906999999999925,185.158632,314.75105399999995,71258112,150,90,7,31,R12,,excluded_warmup
runtime-readiness-measured-1,runtime-readiness,measured,success,true,,,,,1.1337999999998374,193.77573299999995,327.4780559999999,70168576,170,80,7,32,R12,,accepted
runtime-readiness-measured-2,runtime-readiness,measured,success,true,,,,,1.026700000000119,214.14763700000003,352.48836099999994,70737920,160,100,8,35,R12,,accepted
runtime-readiness-measured-3,runtime-readiness,measured,success,true,,,,,1.0259000000000924,176.49273100000005,308.44715299999984,68075520,150,60,7,30,R12,,accepted
runtime-readiness-measured-4,runtime-readiness,measured,success,true,,,,,1.1632010000002992,196.5708340000001,330.07255699999996,69898240,150,100,7,32,R12,,accepted
runtime-readiness-measured-5,runtime-readiness,measured,success,true,,,,,0.8355999999998858,197.90753399999994,328.36795699999993,71102464,140,100,7,32,R12,,accepted
runtime-readiness-measured-6,runtime-readiness,measured,success,true,,,,,1.1205999999997402,193.6984339999999,324.5070559999999,71266304,160,90,8,32,R12,,accepted
runtime-readiness-measured-7,runtime-readiness,measured,success,true,,,,,1.540599999999813,186.84803199999988,320.8847549999996,71442432,150,80,4,31,R12,,accepted
runtime-readiness-measured-8,runtime-readiness,measured,success,true,,,,,1.0502999999998792,184.89793199999986,315.7131549999999,69210112,160,80,6,31,R12,,accepted
runtime-readiness-measured-9,runtime-readiness,measured,success,true,,,,,1.284099999999853,174.82352999999966,305.87655299999915,70942720,150,70,7,30,R12,,accepted
runtime-readiness-measured-10,runtime-readiness,measured,success,true,,,,,2.488199999999779,198.91473399999995,336.64595800000006,63619072,160,90,7,32,R12,,accepted
runtime-readiness-measured-11,runtime-readiness,measured,success,true,,,,,1.4564999999993233,179.80213099999946,306.63135299999976,69263360,140,70,7,30,R12,,accepted
runtime-readiness-measured-12,runtime-readiness,measured,success,true,,,,,1.1925010000004477,201.9923349999999,327.7353570000005,70496256,170,80,7,32,R12,,accepted
runtime-readiness-measured-13,runtime-readiness,measured,success,true,,,,,13.566102000000683,185.28713200000038,328.6586560000005,70410240,150,70,7,29,R12,,accepted
runtime-readiness-measured-14,runtime-readiness,measured,success,true,,,,,1.0830009999999675,213.28773699999965,345.90736000000015,71081984,170,100,7,34,R12,,accepted
runtime-readiness-measured-15,runtime-readiness,measured,success,true,,,,,1.453799999999319,183.55233099999987,315.6487539999998,68579328,130,110,7,31,R12,,accepted
runtime-readiness-measured-16,runtime-readiness,measured,success,true,,,,,1.2429000000001906,176.73141399999986,317.30101100000047,68849664,100,100,7,31,R12,,accepted
runtime-readiness-measured-17,runtime-readiness,measured,success,true,,,,,1.0574010000000271,193.95833399999992,320.76262099999985,71598080,120,120,7,32,R12,,accepted
runtime-readiness-measured-18,runtime-readiness,measured,success,true,,,,,7.150104999999712,202.9333399999996,333.9677299999994,70479872,170,60,6,32,R12,,accepted
runtime-readiness-measured-19,runtime-readiness,measured,success,true,,,,,1.4121010000008027,185.46872800000074,316.31451800000013,69980160,140,110,7,31,R12,,accepted
runtime-readiness-measured-20,runtime-readiness,measured,success,true,,,,,1.0802010000006703,210.88544600000023,339.8766340000002,67747840,170,70,7,34,R12,,accepted
hub-fresh-readiness-warmup-1,hub-fresh-readiness,warmup,success,true,,,,,,,435.044626,126464000,690,120,2,42,H+Z,,excluded_warmup
hub-fresh-readiness-warmup-2,hub-fresh-readiness,warmup,success,true,,,,,,,421.3866260000002,115372032,660,130,2,41,H+Z,,excluded_warmup
hub-fresh-readiness-measured-1,hub-fresh-readiness,measured,success,true,,,,,,,446.75072699999987,120004608,650,180,2,44,H+Z,,accepted
hub-fresh-readiness-measured-2,hub-fresh-readiness,measured,success,true,,,,,,,413.75042600000006,109154304,590,160,2,39,H+Z,,accepted
hub-fresh-readiness-measured-3,hub-fresh-readiness,measured,success,true,,,,,,,399.51852400000007,114720768,650,120,2,39,H+Z,,accepted
hub-fresh-readiness-measured-4,hub-fresh-readiness,measured,success,true,,,,,,,430.3694220000002,119001088,650,150,2,42,H+Z,,accepted
hub-fresh-readiness-measured-5,hub-fresh-readiness,measured,success,true,,,,,,,425.92542199999934,121442304,670,150,2,41,H+Z,,accepted
hub-fresh-readiness-measured-6,hub-fresh-readiness,measured,success,true,,,,,,,380.52631999999994,112607232,600,160,2,36,H+Z,,accepted
hub-fresh-readiness-measured-7,hub-fresh-readiness,measured,success,true,,,,,,,360.7423180000005,119189504,600,150,2,36,H+Z,,accepted
hub-fresh-readiness-measured-8,hub-fresh-readiness,measured,success,true,,,,,,,430.78462300000047,117604352,600,190,2,42,H+Z,,accepted
hub-fresh-readiness-measured-9,hub-fresh-readiness,measured,success,true,,,,,,,414.63482100000056,123932672,630,170,2,41,H+Z,,accepted
hub-fresh-readiness-measured-10,hub-fresh-readiness,measured,success,true,,,,,,,408.3656209999999,121106432,640,130,2,40,H+Z,,accepted
hub-fresh-readiness-measured-11,hub-fresh-readiness,measured,success,true,,,,,,,369.334519,111173632,600,130,2,36,H+Z,,accepted
hub-fresh-readiness-measured-12,hub-fresh-readiness,measured,success,true,,,,,,,420.8633209999989,121188352,670,150,2,41,H+Z,,accepted
hub-fresh-readiness-measured-13,hub-fresh-readiness,measured,success,true,,,,,,,404.7155210000001,116912128,610,150,2,40,H+Z,,accepted
hub-fresh-readiness-measured-14,hub-fresh-readiness,measured,success,true,,,,,,,406.7143209999995,124825600,680,130,2,40,H+Z,,accepted
hub-fresh-readiness-measured-15,hub-fresh-readiness,measured,success,true,,,,,,,422.18132199999854,117268480,690,100,2,42,H+Z,,accepted
hub-fresh-readiness-measured-16,hub-fresh-readiness,measured,success,true,,,,,,,417.7075190000014,117174272,630,170,2,41,H+Z,,accepted
hub-fresh-readiness-measured-17,hub-fresh-readiness,measured,success,true,,,,,,,437.6990189999997,113909760,570,220,2,43,H+Z,,accepted
hub-fresh-readiness-measured-18,hub-fresh-readiness,measured,success,true,,,,,,,439.97991999999977,109154304,660,160,2,43,H+Z,,accepted
hub-fresh-readiness-measured-19,hub-fresh-readiness,measured,success,true,,,,,,,433.507520000001,116256768,660,130,2,40,H+Z,,accepted
hub-fresh-readiness-measured-20,hub-fresh-readiness,measured,success,true,,,,,,,423.4568199999994,107888640,620,170,1,41,H+Z,,accepted
hub-migrated-readiness-warmup-1,hub-migrated-readiness,warmup,success,true,,,,,,,426.2574390000001,117972992,620,170,2,41,H+Z,,excluded_warmup
hub-migrated-readiness-warmup-2,hub-migrated-readiness,warmup,success,true,,,,,,,304.897156,108498944,520,90,2,30,H+Z,,excluded_warmup
hub-migrated-readiness-measured-1,hub-migrated-readiness,measured,success,true,,,,,,,358.86004800000023,119259136,530,170,2,35,H+Z,,accepted
hub-migrated-readiness-measured-2,hub-migrated-readiness,measured,success,true,,,,,,,357.6220489999996,116494336,540,120,2,35,H+Z,,accepted
hub-migrated-readiness-measured-3,hub-migrated-readiness,measured,success,true,,,,,,,319.77615400000013,116420608,540,110,2,32,H+Z,,accepted
hub-migrated-readiness-measured-4,hub-migrated-readiness,measured,success,true,,,,,,,348.2525780000001,107347968,530,120,2,34,H+Z,,accepted
hub-migrated-readiness-measured-5,hub-migrated-readiness,measured,success,true,,,,,,,358.03189199999997,109060096,520,130,2,35,H+Z,,accepted
hub-migrated-readiness-measured-6,hub-migrated-readiness,measured,success,true,,,,,,,353.610592,115113984,540,150,2,34,H+Z,,accepted
hub-migrated-readiness-measured-7,hub-migrated-readiness,measured,success,true,,,,,,,324.50789299999997,105222144,510,120,1,31,H+Z,,accepted
hub-migrated-readiness-measured-8,hub-migrated-readiness,measured,success,true,,,,,,,347.38549200000034,121212928,560,120,2,34,H+Z,,accepted
hub-migrated-readiness-measured-9,hub-migrated-readiness,measured,success,true,,,,,,,347.14569200000005,112766976,540,130,2,34,H+Z,,accepted
hub-migrated-readiness-measured-10,hub-migrated-readiness,measured,success,true,,,,,,,352.5651909999997,116948992,570,130,2,35,H+Z,,accepted
hub-migrated-readiness-measured-11,hub-migrated-readiness,measured,success,true,,,,,,,330.24599300000045,107978752,550,130,1,32,H+Z,,accepted
hub-migrated-readiness-measured-12,hub-migrated-readiness,measured,success,true,,,,,,,343.52159199999915,117764096,490,190,2,34,H+Z,,accepted
hub-migrated-readiness-measured-13,hub-migrated-readiness,measured,success,true,,,,,,,329.71019200000046,109215744,500,170,1,32,H+Z,,accepted
hub-migrated-readiness-measured-14,hub-migrated-readiness,measured,success,true,,,,,,,286.3768940000009,109752320,440,170,2,28,H+Z,,accepted
hub-migrated-readiness-measured-15,hub-migrated-readiness,measured,success,true,,,,,,,341.63469199999963,114315264,480,160,2,34,H+Z,,accepted
hub-migrated-readiness-measured-16,hub-migrated-readiness,measured,success,true,,,,,,,365.15099100000043,119648256,590,120,2,36,H+Z,,accepted
hub-migrated-readiness-measured-17,hub-migrated-readiness,measured,success,true,,,,,,,350.3084920000001,115691520,560,100,2,34,H+Z,,accepted
hub-migrated-readiness-measured-18,hub-migrated-readiness,measured,success,true,,,,,,,350.09461199999896,113946624,540,140,2,34,H+Z,,accepted
hub-migrated-readiness-measured-19,hub-migrated-readiness,measured,success,true,,,,,,,356.09021199999916,115187712,560,120,2,35,H+Z,,accepted
hub-migrated-readiness-measured-20,hub-migrated-readiness,measured,success,true,,,,,,,353.25731199999973,111321088,470,170,2,35,H+Z,,accepted
```

</details>

## Matching-symbol attribution cohort, 2026-10-23

A separate **unscored** GNU artifact cohort closes the current dependency-attribution gap. It uses
source `805d2b536e5d5ad7e959bb0c1b5d3a6290878005`, input seal
`6a36c1e4ddf08df28ea196c8655d11607eda77660f2f736b67349dbb9c9ecdcd`, version `0.1.1`, default features,
eight jobs and target `x86_64-unknown-linux-gnu`. Rust/Cargo 1.99.0 (b940084d7 / 5f94df478), LLVM
23.1.1 and Bun 1.4.3 are unchanged. The two packages were built once each in a new private ext4
Cargo target, runtime then launcher, with populated registry/toolchain caches and Cargo offline.
The workspace release codegen remains opt-level 3 / fat LTO / one codegen unit / unwind; only
stripping is disabled to retain symbols. V3L uses this workspace audit profile; these values
do not qualify arbitrary launcher installations built with a cargo-install profile.

Pinned cargo-bloat 0.12.1 has SHA-256
`28c5f0f8070dc6fe3023066a56f1dcf35e80347fcdeebfe3532e9a732dbb0954`.
Its GNU build path injects `CARGO_PROFILE_RELEASE_STRIP=false`; its forced debug setting applies only
to MSVC. The frozen child environment had `RUSTFLAGS` and `CARGO_ENCODED_RUSTFLAGS` unset. Captured
verbose binary invocations had exactly these `-C` values:

| Binary   | Codegen values                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime  | `opt-level=3`, `lto=fat`, `codegen-units=1`, `metadata=e2d8f00e67dcf235`, `extra-filename=-1752e5e7b56dac33` |
| Launcher | `opt-level=3`, `lto=fat`, `codegen-units=1`, `metadata=2346ad337e441315`, `extra-filename=-0ba43966a803d021` |

Neither invocation added `link-dead-code`, `debuginfo`, `strip` or `panic=abort`; the profile/target
retains unwind and the no-strip default. Retained debug sections are listed below rather than
inferred absent from the compiler flags. These actual flags and artifact hashes define the cohort;
matching three profile fields alone does not establish equivalence to a different artifact.

V3R and V3L are new post-link stripped copies of their own preserved symbol-bearing builds.
GNU strip 2.46, SHA-256 `4d2ca6ba80677c3b2975e328306a779cd7bd6590a87948b5ebea9c1b41a049c8`,
applied `--strip-all` to each copy. Cargo documents `strip=true` as `strip="symbols"`, and GNU
`--strip-all` removes symbols; this reproduces that stripping policy without claiming byte identity
to an earlier Cargo-linked file. See the [Cargo profile documentation](https://doc.rust-lang.org/cargo/reference/profiles.html#strip)
and [GNU strip manual](https://sourceware.org/binutils/docs/binutils/strip.html).

Both pairs have exactly equal pre/post `.text` bytes and SHA-256, unchanged original/symbol copies,
removed static symbol/debug sections and preserved `.text`, `.rodata`, `.eh_frame` and
`.gcc_except_table` sizes/addresses. Runtime `--version` returned `0.1.1` under an isolated home;
the launcher was never executed and its version came from sealed Cargo metadata. Their stripped
file sizes are **26,430,696 bytes** (V3R) and **2,223,120 bytes** (V3L). Attribution is accepted only
for these new copies. Old R12/Z attribution remains rejected, and every v2 timing/startup sample,
warmup, failed admission and unqualified symbol result above remains unchanged.

### Current code attribution and coverage

`--crates --split-std -n 0` retained all 130 runtime and 38 launcher rows, without a filter or top-N
truncation. Named crates, unknown symbols and residual bytes sum exactly to each `.text` section:

| Artifact | Crate rows | Text bytes | Named-crate bytes | Unknown-symbol bytes | Residual text bytes |
| -------- | ---------: | ---------: | ----------------: | -------------------: | ------------------: |
| V3R      |        130 |   19820037 |          18737863 |               912729 |              169445 |
| V3L      |         38 |    1570246 |           1482460 |                71253 |               16533 |

Fat-LTO crate attribution remains heuristic, including inlined/shared code. `[Unknown]` contains
symbols the tool could not assign; `[Residual]` is `.text` outside its summed symbol rows, including
unassigned bytes or padding. It is kept separately instead of assigning it to a dependency.
The rows include the application and split standard-library crates. Packages without an attributed
symbol do not appear; their absence does not prove zero contribution. These are `.text` attributions,
not shares of the entire file or runtime memory. The full crate rows and complete ELF section sizes
are retained below; `NOBITS` describes memory size, not bytes stored in the file. Empty stripped
section fields mean the section was removed.

<details>
<summary>New matching artifact identities (CSV)</summary>

```csv
artifact_id,package,version,file_bytes,text_bytes,file_sha256,text_sha256
V3R-symbols,mangostudio-runtime,0.1.1,36120064,19820037,ccb8f44ef8d3e78b1f6bb84bef1a6f9e6bad9211ecfd2c34efcc8eb4279fc915,a936d68748eacfcfe86889279ef4c30d4835d371fee273d30715f5a1ebb10ed3
V3R,mangostudio-runtime,0.1.1,26430696,19820037,7a8e792aec2f42144b0b3fd487fac0bbd44ff917acb44df511d413f732bf870e,a936d68748eacfcfe86889279ef4c30d4835d371fee273d30715f5a1ebb10ed3
V3L-symbols,mangostudio,0.1.1,6575560,1570246,7d83415f7c9129257407bc7778ce98f4a723fb380b9fb0c1d6cce3ee3bb03d94,4f7feed6909387a51e2a8ce0eb57e3c5f034563273b87f5153564dc5ba1a9e2d
V3L,mangostudio,0.1.1,2223120,1570246,8906b428ac27b17b5568915596839c2b6512f01fb5836636859bba70892e358b,4f7feed6909387a51e2a8ce0eb57e3c5f034563273b87f5153564dc5ba1a9e2d
```

</details>

<details>
<summary>Complete section sizes (CSV)</summary>

Independent reads of the two symbol-bearing ELF files returned equal sizes for `.debug_loclists`
(1,117,567 bytes), `.debug_rnglists` (52,758), `.debug_macro` (38,458) and `.debug_line_str` (7,661).
The first three sections have different SHA-256 hashes between V3R and V3L; `.debug_line_str`
has the same hash. These are observed section sizes; they do not imply equal binaries.

```csv
artifact_id,section,elf_type,symbol_bytes,stripped_bytes,symbol_address,stripped_address
V3R,.interp,PROGBITS,28,28,736,736
V3R,.note.ABI-tag,NOTE,32,32,764,764
V3R,.note.gnu.build-id,NOTE,36,36,796,796
V3R,.dynsym,DYNSYM,5568,5568,832,832
V3R,.gnu.version,VERSYM,464,464,6400,6400
V3R,.gnu.version_r,VERNEED,528,528,6864,6864
V3R,.gnu.hash,GNU_HASH,28,28,7392,7392
V3R,.dynstr,STRTAB,3006,3006,7420,7420
V3R,.rela.dyn,RELA,632712,632712,10432,10432
V3R,.rela.plt,RELA,1680,1680,643144,643144
V3R,.gcc_except_table,PROGBITS,1037452,1037452,644824,644824
V3R,.rodata,PROGBITS,2777792,2777792,1683456,1683456
V3R,.eh_frame_hdr,PROGBITS,181292,181292,4461248,4461248
V3R,.eh_frame,PROGBITS,1498328,1498328,4642544,4642544
V3R,.text,PROGBITS,19820037,19820037,6145024,6145024
V3R,.init,PROGBITS,27,27,25965064,25965064
V3R,.fini,PROGBITS,13,13,25965092,25965092
V3R,.plt,PROGBITS,1136,1136,25965120,25965120
V3R,.tdata,PROGBITS,249,249,25970352,25970352
V3R,.tbss,NOBITS,168,168,25970608,25970608
V3R,.fini_array,FINI_ARRAY,8,8,25970608,25970608
V3R,.init_array,INIT_ARRAY,16,16,25970616,25970616
V3R,.data.rel.ro,PROGBITS,454400,454400,25970656,25970656
V3R,.dynamic,DYNAMIC,464,464,26425056,26425056
V3R,.got,PROGBITS,2464,2464,26425520,26425520
V3R,.got.plt,PROGBITS,584,584,26427984,26427984
V3R,.relro_padding,NOBITS,2920,2920,26428568,26428568
V3R,.tm_clone_table,PROGBITS,0,0,26432664,26432664
V3R,.data,PROGBITS,7704,7704,26432672,26432672
V3R,.bss,NOBITS,536,536,26440384,26440384
V3R,.comment,PROGBITS,177,177,0,0
V3R,.debug_abbrev,PROGBITS,15239,,0,
V3R,.debug_info,PROGBITS,1042037,,0,
V3R,.debug_aranges,PROGBITS,14656,,0,
V3R,.debug_ranges,PROGBITS,283024,,0,
V3R,.debug_str,PROGBITS,1444143,,0,
V3R,.debug_line,PROGBITS,510268,,0,
V3R,.debug_loclists,PROGBITS,1117567,,0,
V3R,.debug_rnglists,PROGBITS,52758,,0,
V3R,.debug_macro,PROGBITS,38458,,0,
V3R,.debug_line_str,PROGBITS,7661,,0,
V3R,.symtab,SYMTAB,868848,,0,
V3R,.shstrtab,STRTAB,478,318,0,0
V3R,.strtab,STRTAB,4293767,,0,
V3L,.interp,PROGBITS,28,28,736,736
V3L,.note.ABI-tag,NOTE,32,32,764,764
V3L,.note.gnu.build-id,NOTE,36,36,796,796
V3L,.dynsym,DYNSYM,3096,3096,832,832
V3L,.gnu.version,VERSYM,258,258,3928,3928
V3L,.gnu.version_r,VERNEED,336,336,4188,4188
V3L,.gnu.hash,GNU_HASH,28,28,4528,4528
V3L,.dynstr,STRTAB,1689,1689,4556,4556
V3L,.rela.dyn,RELA,60240,60240,6248,6248
V3L,.rela.plt,RELA,96,96,66488,66488
V3L,.gcc_except_table,PROGBITS,37248,37248,66584,66584
V3L,.rodata,PROGBITS,357029,357029,106496,106496
V3L,.eh_frame_hdr,PROGBITS,17876,17876,463528,463528
V3L,.eh_frame,PROGBITS,119836,119836,481408,481408
V3L,.text,PROGBITS,1570246,1570246,605376,605376
V3L,.init,PROGBITS,27,27,2175624,2175624
V3L,.fini,PROGBITS,13,13,2175652,2175652
V3L,.plt,PROGBITS,80,80,2175680,2175680
V3L,.tdata,PROGBITS,49,49,2179856,2179856
V3L,.tbss,NOBITS,72,72,2179912,2179912
V3L,.fini_array,FINI_ARRAY,8,8,2179912,2179912
V3L,.init_array,INIT_ARRAY,16,16,2179920,2179920
V3L,.data.rel.ro,PROGBITS,43872,43872,2179936,2179936
V3L,.dynamic,DYNAMIC,448,448,2223808,2223808
V3L,.got,PROGBITS,1696,1696,2224256,2224256
V3L,.got.plt,PROGBITS,56,56,2225952,2225952
V3L,.relro_padding,NOBITS,2216,2216,2226008,2226008
V3L,.tm_clone_table,PROGBITS,0,0,2230104,2230104
V3L,.data,PROGBITS,2696,2696,2230104,2230104
V3L,.bss,NOBITS,280,280,2232800,2232800
V3L,.comment,PROGBITS,177,177,0,0
V3L,.debug_abbrev,PROGBITS,11257,,0,
V3L,.debug_info,PROGBITS,872900,,0,
V3L,.debug_aranges,PROGBITS,10848,,0,
V3L,.debug_ranges,PROGBITS,213120,,0,
V3L,.debug_str,PROGBITS,1255976,,0,
V3L,.debug_line,PROGBITS,424444,,0,
V3L,.debug_loclists,PROGBITS,1117567,,0,
V3L,.debug_rnglists,PROGBITS,52758,,0,
V3L,.debug_macro,PROGBITS,38458,,0,
V3L,.debug_line_str,PROGBITS,7661,,0,
V3L,.symtab,SYMTAB,76128,,0,
V3L,.shstrtab,STRTAB,478,318,0,0
V3L,.strtab,STRTAB,270389,,0,
```

</details>

<details>
<summary>All crate rows and residuals (CSV)</summary>

```csv
artifact_id,crate,text_bytes
V3R,mangostudio_runtime,3171895
V3R,jsonschema,2640131
V3R,core,2055993
V3R,tokio,1467702
V3R,serde_core,923855
V3R,[Unknown],912729
V3R,rmcp,812748
V3R,mango_external_agents,770040
V3R,mango_protocol,719961
V3R,serde_json,677577
V3R,mango_agent_codex,662288
V3R,mango_agent_acp,539017
V3R,rustls,389951
V3R,ring,283533
V3R,regex_automata,282110
V3R,alloc,245193
V3R,mango_agent_claude,243968
V3R,std,229725
V3R,regex_syntax,180723
V3R,fancy_regex,165461
V3R,referencing,158515
V3R,agent_client_protocol_schema,143232
V3R,aho_corasick,138887
V3R,reqwest,131153
V3R,rquickjs_sys,101939
V3R,serde_with,101496
V3R,serde,95891
V3R,hyper_util,81731
V3R,tungstenite,70362
V3R,http,67143
V3R,webpki,63975
V3R,icu_collator,60777
V3R,futures_util,58873
V3R,hyper,58114
V3R,url,51096
V3R,num_bigint,48725
V3R,indexmap,47557
V3R,hashbrown,42824
V3R,toml,40107
V3R,toml_parser,35367
V3R,gimli,35344
V3R,tokio_util,33732
V3R,data_encoding,27882
V3R,tokio_tungstenite,25092
V3R,darling_core,24026
V3R,idna,23736
V3R,cc,23086
V3R,fluent_uri,22473
V3R,cap_primitives,22360
V3R,rustc_demangle,21251
V3R,jsonschema_regex,20832
V3R,memchr,19808
V3R,proc_macro2,16674
V3R,icu_normalizer,16474
V3R,mangostudio_runtime_contract,16392
V3R,tokio_rustls,16188
V3R,heck,15540
V3R,hyper_rustls,13708
V3R,rustls_pki_types,12187
V3R,jsonschema_value,12056
V3R,addr2line,11631
V3R,smallvec,11416
V3R,sha2,11316
V3R,tracing,10417
V3R,miniz_oxide,9875
V3R,base64,9437
V3R,http_body_util,8538
V3R,rustls_native_certs,8486
V3R,regex,8465
V3R,fraction,8430
V3R,icu_locale_core,7451
V3R,bytes,7215
V3R,rquickjs_core,6860
V3R,parking_lot,6592
V3R,autocfg,6462
V3R,httparse,6381
V3R,icu_locale_fallback,6349
V3R,rustls_platform_verifier,6163
V3R,toml_datetime,5941
V3R,globset,5917
V3R,compiler_builtins,5642
V3R,tower,5599
V3R,getrandom,5566
V3R,ahash,5427
V3R,sha1,5376
V3R,ipnet,5169
V3R,chrono,4539
V3R,icu_provider,4478
V3R,sse_stream,4364
V3R,email_address,4050
V3R,syn,3851
V3R,rustix,3587
V3R,num_rational,3549
V3R,semver,3018
V3R,find_msvc_tools,2827
V3R,futures_channel,2458
V3R,zmij,2396
V3R,rand,1909
V3R,parking_lot_core,1864
V3R,std_detect,1727
V3R,uuid,1493
V3R,zerotrie,1336
V3R,icu_collections,1326
V3R,uuid_simd,1207
V3R,chacha20,1117
V3R,signal_hook_registry,1109
V3R,foldhash,1105
V3R,version_check,1028
V3R,tower_http,1015
V3R,digest,1014
V3R,shlex,874
V3R,itoa,846
V3R,percent_encoding,832
V3R,bit_set,683
V3R,bytecount,645
V3R,convert_case,523
V3R,futures_task,362
V3R,mio,353
V3R,__rustc,341
V3R,want,338
V3R,zerovec,297
V3R,utf8_iter,296
V3R,panic_abort,219
V3R,openssl_probe,87
V3R,strsim,49
V3R,untrusted,44
V3R,unicode_segmentation,36
V3R,nix,26
V3R,http_body,26
V3R,panic_unwind,22
V3R,[Residual],169445
V3L,rustls,379896
V3L,ring,283487
V3L,core,191650
V3L,ureq,135177
V3L,std,116872
V3L,[Unknown],71253
V3L,tar,50247
V3L,webpki,44343
V3L,mangostudio,42132
V3L,gimli,37393
V3L,alloc,34748
V3L,http,29374
V3L,miniz_oxide,22281
V3L,ureq_proto,20738
V3L,rustc_demangle,20659
V3L,addr2line,12836
V3L,sha2,11316
V3L,flate2,8822
V3L,rustls_pki_types,6542
V3L,cc,6078
V3L,bytes,5427
V3L,crc32fast,4717
V3L,httparse,3489
V3L,find_msvc_tools,3096
V3L,hashbrown,2269
V3L,base64,1844
V3L,std_detect,1727
V3L,filetime,969
V3L,simd_adler32,856
V3L,memchr,840
V3L,rustix,708
V3L,getrandom,682
V3L,shlex,548
V3L,__rustc,329
V3L,panic_abort,219
V3L,compiler_builtins,83
V3L,untrusted,44
V3L,panic_unwind,22
V3L,[Residual],16533
```

</details>

### Reproduction and limits

The exact source, tools, profile and default feature selection above are required. Use a fresh
output/target, clear unrelated compiler/profile overrides and inspect all returned rows. These commands
show the same build/copy/strip/section workflow; the executed supervised cohort also required unchanged
source/tool/old-evidence seals, exact bloat file/text counts, unique nonempty crate rows, bounded
allocation and empty terminal process scopes.

```bash
# From the recorded source, with cargo-bloat 0.12.1 and GNU binutils 2.46.
mkdir -p target
cohort_target=$(mktemp -d "$PWD/target/attribution-v3.XXXXXX")
cohort_out=$(mktemp -d)
cat > "$cohort_out/profile.toml" <<'PROFILE'
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
strip = "none"
panic = "unwind"
PROFILE
for cohort_package in mangostudio-runtime mangostudio; do
  env -i HOME="$HOME" USERPROFILE="$HOME" PATH="$PATH" \
    CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    CARGO_INCREMENTAL=0 CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=8 \
    MANGOSTUDIO_RELEASE_VERSION=0.1.1 CARGO_PROFILE_RELEASE_STRIP=none \
    cargo bloat --config "$cohort_out/profile.toml" --release --locked -j 8 \
      --target x86_64-unknown-linux-gnu --target-dir "$cohort_target" \
      -p "$cohort_package" --bin "$cohort_package" --crates --split-std -n 0 \
      --message-format json -v > "$cohort_out/$cohort_package.bloat.json"
  cp "$cohort_target/x86_64-unknown-linux-gnu/release/$cohort_package" \
    "$cohort_out/$cohort_package.symbols"
  cp "$cohort_out/$cohort_package.symbols" "$cohort_out/$cohort_package.stripped"
  strip --strip-all -- "$cohort_out/$cohort_package.stripped"
  for cohort_kind in symbols stripped; do
    size -A -d "$cohort_out/$cohort_package.$cohort_kind"
    readelf -h -S -W "$cohort_out/$cohort_package.$cohort_kind"
    objcopy --dump-section ".text=$cohort_out/$cohort_package.$cohort_kind.text" \
      "$cohort_out/$cohort_package.$cohort_kind" "$cohort_out/inspection-copy"
  done
  cmp "$cohort_out/$cohort_package.symbols.text" "$cohort_out/$cohort_package.stripped.text"
  sha256sum "$cohort_out/$cohort_package."{symbols,stripped}{,.text}
done
```

Both cases qualified without retry. All 17 supervised commands exited successfully with no historical
census error and empty scopes; 231 owned identities were observed and zero remained. The final
allocation check recorded 1,165,455,360 bytes for the private Cargo target and
121,614,336 bytes for artifact/receipt output (1,287,069,696 combined). The reservation was 30 minutes with an 8 GiB boundary gate,
not a hard mid-build quota. No source/dependency/feature/profile file changed. Native Windows/macOS
attribution remains unperformed. This cohort supplies artifact sizes and a matching-symbol baseline;
command durations are unscored and add no build/startup timing, optimization or savings claim.
