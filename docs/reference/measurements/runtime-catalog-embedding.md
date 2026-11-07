# Runtime catalog embedding: Linux artifact qualification

## Initial qualification on 2026-11-04

On 2026-11-04, a build-only lexical compaction of the embedded runtime catalog
reduced the local Linux x64 release executable by **225,280 bytes (0.825%)** and
the complete compressed distribution by **6,934 bytes (0.012%)**. Two serial
pairs reproduced identical binary and archive hashes within each variant.
This qualifies an artifact-size improvement on the tested executor. It does not
establish a startup, memory, throughput, build-time or other-platform improvement.

## Source and build controls

- Baseline: `69a5d9d30c8d6bf22526d5f2c346b4a946273f16`.
- Measured implementation: `fc5199ebe9216513431f51a0392a8195c34369f1`.
  Subsequent receipt edits do not change the measured Rust source.
  `83bdb647` changes the build script's write path: identical compact bytes are
  left untouched. It does not change `compact_json` output or the embedded
  payload, and this receipt does not remeasure that commit.
- Identical Cargo.lock SHA-256:
  `5a005cc53823f64e53bb33d573175231eba0819f5ad408f7230798212e82b25d`.
- Linux 6.18.57 x86_64, host glibc 2.41, overlayfs, five available CPUs,
  approximately 17.6 GiB RAM; four Cargo build jobs. No competing build ran in
  this executor. Measurements ran serially, never on a shared benchmark runner.
- Rust 1.99.0 (`b940084d7`, LLVM 23.1.1), Zig 0.15.2,
  cargo-zigbuild 0.23.4. Zig/cargo-zigbuild came from PyPI wheels at CI's pinned
  versions; their installation source differs from CI. No toolchain version moved.
- Target: `x86_64-unknown-linux-gnu.2.17`, default production features, locked
  graph, original release profile: opt-level 3, fat LTO, one codegen unit,
  stripping enabled, **panic=unwind**. All four External Agents crates remained
  at 0.7.1. No runtime dependency or validator was removed.
- Separate clean source worktrees and target directories per variant, retained
  registry/toolchain caches, uncontrolled OS page cache. Before the second pair,
  clean only the runtime and runtime-contract crates, then rebuild. Empty targets
  are not described as machine-cold runs. No timing metric determines acceptance.
- Apply the same path-remapping flags on both builds, mapping each source
  worktree to `/study`; record these flags as a measurement control, not an
  optimization or a production build-policy change.

## Workload and acceptance

Run the canonical build from each variant with a separate target/output directory:

```sh
VERSION=0.1.1-canary.69a5d9d CARGO_BUILD_JOBS=4 \
  bun run build:runtime --platform linux-x64 --zig --out <variant-output>
```

The same release version is stamped into both runtimes. The build script verified
ELF x64, the GLIBC 2.17 floor and the reported version on all four attempts.
The original readable generated JSON is unchanged. The candidate derives its compact
representation in Cargo OUT_DIR, removing JSON whitespace outside strings only.

Hold the exact hub and README from the published `v0.1.1-canary.69a5d9d` Linux
x64 bundle fixed. Verify the downloaded bundle against its release SHA256SUMS.
Use the repository's `tar -czf` method and member order:
`mangostudio`, `mangostudio-runtime`, `README.md`. Normalize all staged mtimes to
Unix epoch; executable modes are 0755 and README mode is 0644. GNU tar 1.35 and
gzip 1.13 produced gzip headers with timestamp zero. Archive extraction verified
every member hash and the identical metadata. No archive member was removed.

Acceptance was declared before the batch: both executable and full archive byte
counts must decrease, repeat with identical hashes per variant, and preserve
focused correctness/conformance behavior. All attempts were retained; none failed
or was excluded. No CI or shared benchmark was dispatched for this study.

## Raw attempts and result

| Attempt order | Variant   | Runtime bytes | Complete archive bytes | Exit |
| ------------- | --------- | ------------: | ---------------------: | ---: |
| 1             | baseline  |    27,306,720 |             57,778,692 |    0 |
| 2             | candidate |    27,081,440 |             57,771,758 |    0 |
| 3             | candidate |    27,081,440 |             57,771,758 |    0 |
| 4             | baseline  |    27,306,720 |             57,778,692 |    0 |

Only `.rodata` changed size: 2,783,940 → 2,558,660 bytes. Every other ELF
section, including `.text`, retained its size. This is a data-size result.
The full binary reduction can differ from the raw JSON reduction because of
link layout/alignment. The raw JSON is 341,851 → 117,995 bytes, a distinct metric.

| Artifact          | SHA-256, identical across both builds of that variant              |
| ----------------- | ------------------------------------------------------------------ |
| baseline binary   | `49076c48e4dd45c7f3d4a682c888cd1105ef4e1a0adf63d8e043a04726b1feb9` |
| baseline archive  | `dde3f2556d64b07e1ee41ecdb37dd87d771dd0a9eecfbdcf44b8191ef9711529` |
| candidate binary  | `8b4fabf7cfe24d0787a57bf82120c2c96a1352d38bd6f9e7fa11e1f4a1609253` |
| candidate archive | `b79ebe9569f9bfa44062a5512b776bc8fc591efc6ed0e17cb4f260cc134606d9` |

Fixed hub SHA-256:
`390d027397f01950d583e4dcd61281650b12fa9601b60f3522a607e365f27ae7`.
Raw attempts, tool/feature/source identities, build logs, section dumps, archives,
archive-content verification and smoke receipts were retained in the isolated
cloud task's evidence directory. These are newly built local artifacts; the
published runtime was not substituted for a local baseline build.

## Correctness and limits

At `83bdb647`, the runtime-contract tests passed: 46 unit tests, three
`compact_catalog` tests covering lexical preservation, determinism, semantic
equality and unchanged-output timestamps, four conformance tests and 17 doctests.
All-target scoped
Clippy with warnings denied, workspace rustfmt and the affected repository check
passed. Exact number lexemes, string escapes, member order, non-ASCII data,
idempotence, parsed Catalog equality and existing validation are covered.

All four actual release executables completed a real stdio handshake, answered
`runtime.health` and `rpc.discover`, refused invalid `fs.read-file` parameters
with `INVALID_PARAMS`, and exited successfully with no surviving child.
Each served 68 methods and six events with the same sorted-JSON catalog SHA-256:
`e6567bc2e5d23d88c36949961e0e8686f19f729855498c9d89913491afd15da4`.
This digest describes the parsed served catalog, not its original JSON lexemes.

The initial study qualified the Linux artifact size for review. The later
measurement below uses the rebased implementation and current catalog.

## Requalification on 2026-11-07

- Baseline: `d3b3280f1a4cedf04f47aca1655d6bdf60fe060d`.
- Candidate: `b3496755f3bb93f3b40f68b8bf21162466b877cb`, including the
  unchanged-output timestamp fix and the malformed-token regression fix.
- Same lockfile, release profile, default features, version stamp, glibc target
  and fixed release bundle inputs as in the initial study. The current raw
  catalog is 343,231 bytes and the compact payload is 118,487 bytes.
- Linux 7.0.0-42 x86_64, host glibc 2.43, btrfs, 24 logical CPUs available.
  Rust 1.99.0 (`b940084d7`, LLVM 23.1.1), checksum-verified Zig 0.15.2,
  cargo-zigbuild 0.23.4 installed with Cargo, GNU tar 1.35 and gzip 1.14.
- The four release builds ran serially with eight Cargo jobs, separate source
  and target directories, source paths remapped to `/study` and target paths
  to `/study/target`. Before each repeat, `cargo clean --release --target
x86_64-unknown-linux-gnu` cleared only the runtime and runtime-contract
  packages. Workspace correctness checks also ran on the host during this
  batch. The comparison uses byte counts and hashes.

| Order | Variant   | Runtime bytes | Complete archive bytes |
| ----: | --------- | ------------: | ---------------------: |
|     1 | Baseline  |    27,422,800 |             57,838,328 |
|     2 | Candidate |    27,201,616 |             57,829,511 |
|     3 | Candidate |    27,201,616 |             57,829,511 |
|     4 | Baseline  |    27,422,800 |             57,838,328 |

All four builds passed. The executable shrank by **221,184 bytes (0.807%)**
and the archive by **8,817 bytes (0.015%)**. The decrease in ELF section size
was entirely in `.rodata`, and `.text` stayed at 20,706,070 bytes. Both
rebuilds reproduced their variant's executable and archive byte for byte.

| Artifact             | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Baseline executable  | `1ae40cb945a834e4dd0b53582e0977cc70f4f8023dc41489bc898e6cae25c3ac` |
| Baseline archive     | `45e47f68c87aea11a2a8f3080c6378a9ea072f551221943ce3cfe61ddf9b9e90` |
| Candidate executable | `962bcef89a1e3a3b23ce28811ec1609e7b631a860c237e082ef0973c9b599287` |
| Candidate archive    | `0c0a273c7d0d1ed09509298b64aab9ac8687a4c5cb82a2921f813dd1f8836f5b` |

Archive extraction reproduced the staged member bytes, modes and timestamps.
Each executable passed version and GLIBC 2.17 verification, completed a stdio
handshake, answered `runtime.health` and `rpc.discover`, rejected malformed
`fs.read-file` parameters with `INVALID_PARAMS`, and exited with code zero.
All four served the same 68 methods and six events. The sorted-JSON catalog
SHA-256 was `b7731ea6bf7ffb328ea2e81f29b28be03d9fcc59e128c32e93aa2d86756eae64`.

The four catalog tests passed, including a regression that failed on the
previous compactor when `[fa lse]` became `[false]`. Workspace rustfmt,
Clippy, 2,496 nextest tests (24 skipped), doctests and rustdoc passed.
The full Bun check, test and build also passed. The measurements apply to
Linux x64 artifact size.
