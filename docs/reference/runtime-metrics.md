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
