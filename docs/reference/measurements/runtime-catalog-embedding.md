# Runtime catalog embedding: Linux artifact qualification

On 2026-11-04, a build-only lexical compaction of the embedded runtime catalog
reduced the local Linux x64 release executable by **225,280 bytes (0.825%)** and
the complete compressed distribution by **6,934 bytes (0.012%)**. Two serial
pairs reproduced identical binary and archive hashes within each variant.
This qualifies an artifact-size improvement on the tested executor. It does not
establish a startup, memory, throughput, build-time or other-platform improvement.

## Source and build controls

- Baseline: `69a5d9d30c8d6bf22526d5f2c346b4a946273f16`.
- Measured implementation: `fc5199ebe9216513431f51a0392a8195c34369f1`.
  Subsequent evidence/documentation changes do not change the measured Rust source.
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

The runtime-contract tests passed: 46 unit tests, two new lexical/determinism/
semantic-equality tests, four conformance tests and 17 doctests. All-target scoped
Clippy with warnings denied, workspace rustfmt and the affected repository check
passed. Exact number lexemes, string escapes, member order, non-ASCII data,
idempotence, parsed Catalog equality and existing validation are covered.

All four actual release executables completed a real stdio handshake, answered
`runtime.health` and `rpc.discover`, refused invalid `fs.read-file` parameters
with `INVALID_PARAMS`, and exited successfully with no surviving child.
Each served 68 methods and six events with the same sorted-JSON catalog SHA-256:
`e6567bc2e5d23d88c36949961e0e8686f19f729855498c9d89913491afd15da4`.
This digest describes the parsed served catalog, not its original JSON lexemes.

**Disposition: adopt for review based on this Linux artifact result.**
Native Windows/macOS, complete workspace gates and hosted CI remain unqualified.
The draft publication keeps build/test CI intentionally suspended as requested;
a later review cycle must enable and pass the required checks before landing.
No merge, deployment or release is established by this receipt.
