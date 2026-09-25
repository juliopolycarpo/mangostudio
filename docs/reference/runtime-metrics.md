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

## Binary size per target

`runtime-build.yml` artifacts, uncompressed. Before: CI on the `feat/rust-runtime` head
`72172b38` (merge ref `4be9c25e`, cargo's default release profile). After: CI on this
profile, source `b2ee0c77` (merge ref `a400be5e`). Build times are the `runtime-build.yml`
job durations of those runs, on shared GitHub-hosted runners.

| Platform           | Before (bytes) | After (bytes) | Change | CI build before | CI build after |
| ------------------ | -------------: | ------------: | -----: | --------------: | -------------: |
| `linux-x64`        |     33,810,720 |    26,022,592 | −23.0% |           4m21s |          7m01s |
| `linux-arm64`      |     30,824,608 |    22,709,960 | −26.3% |           5m04s |          6m07s |
| `linux-x64-musl`   |     32,847,992 |    25,519,248 | −22.3% |           3m23s |          5m58s |
| `linux-arm64-musl` |     29,967,520 |    22,208,256 | −25.9% |           5m06s |          6m58s |
| `darwin-x64`       |     41,598,856 |    24,483,648 | −41.1% |           5m46s |          9m48s |
| `darwin-arm64`     |     40,541,120 |    22,275,376 | −45.1% |           8m23s |         11m19s |
| `windows-x64`      |     40,247,296 |    33,669,120 | −16.3% |           9m15s |         12m41s |
| `windows-arm64`    |     33,764,352 |    28,660,224 | −15.1% |          10m33s |         14m08s |
| **all 8**          |    283,602,464 |   205,548,424 | −27.5% |                 |                |

Linux targets were already stripped before (zig's linker drops symbols), so their change is
LTO and one codegen unit alone. The darwin binaries shrink most because the default profile
left their symbol table in (about 88,000 symbols, against 251 now). A Windows executable
carries no symbol table to strip, so its change is LTO alone. The fat-LTO build adds 1 to 4 minutes per target, well inside
the job's 30-minute timeout.

## What the linux-x64 binary is made of

`CARGO_PROFILE_RELEASE_STRIP=false cargo bloat --release --locked -p mangostudio-runtime --bin mangostudio-runtime --crates -n 20`
on the shipped profile. The `.text` section is 18.8 MiB of a 34.3 MiB unstripped file;
attribution under fat LTO is approximate.

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

`git diff -M50% --numstat origin/main...b2ee0c77`, classified by path:

- **docs**: `docs/**` and any `*.md`.
- **generated**: paths under `generated/`, `Cargo.lock`, `bun.lock`.
- **tests**: `tests/`, `fixtures/`, `examples/`, `fuzz/` directories, `*.test.ts(x)`, and Rust
  `tests.rs`/`*_tests.rs`/`testing.rs` files. **Rust (inline modules)** counts the lines of
  `#[cfg(test)] mod … { }` blocks inside Rust source files and removes them from production.
- **production**: everything else. TS means `.ts`/`.tsx`/`.js`; other means JSON, YAML, TOML,
  shell, and the rest.

| Kind           | Language              | Files |  Added | Deleted |     Net |
| -------------- | --------------------- | ----: | -----: | ------: | ------: |
| production     | TypeScript            |   889 |  5,596 |  40,556 | −34,960 |
| production     | Rust                  |   179 | 64,079 |      25 | +64,054 |
| production     | other                 |    39 |    882 |     469 |    +413 |
| tests          | TypeScript            |   268 | 19,721 |  29,215 |  −9,494 |
| tests          | Rust (test files)     |    49 | 23,072 |      16 | +23,056 |
| tests          | Rust (inline modules) |   131 | 32,637 |       0 | +32,637 |
| tests          | other                 |    20 |  4,401 |     177 |  +4,224 |
| docs           | Markdown              |    39 |  1,683 |     480 |  +1,203 |
| generated      | other                 |     8 | 25,217 |     245 | +24,972 |
| **production** | all                   |       | 70,557 |  41,050 | +29,507 |
| **tests**      | all                   |       | 79,831 |  29,408 | +50,423 |
| **docs**       | all                   |       |  1,683 |     480 |  +1,203 |
| **generated**  | all                   |       | 25,217 |     245 | +24,972 |

The inline-module row re-counts lines of production Rust files, so its file count overlaps the
production Rust row; its lines are subtracted there. One binary file is not counted.

The TypeScript runtime's removal is most of the production TS deletions; its behaviour moved
into the Rust production lines, and its compatibility coverage into Rust tests and frozen
fixtures.

## Re-measuring

- Sizes: download the `runtime-<sha>-<platform>` artifacts of a CI run
  (`gh run download <run-id> -p 'runtime-*'`) and compare file sizes.
- Composition: the `cargo bloat` command above, on Linux x64.
- Code volume: the `git diff` above against the current `origin/main`.
