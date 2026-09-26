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

## Re-measuring

- Sizes: download the `runtime-<sha>-<platform>` artifacts of a CI run
  (`gh run download <run-id> -p 'runtime-*'`) and compare file sizes.
- Composition: the `cargo bloat` command above, on Linux x64.
- Code volume: the `git diff` above against the current `origin/main`.
