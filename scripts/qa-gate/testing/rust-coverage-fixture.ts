// Test-only builders for the files the CI Rust coverage job uploads: an
// llvm-cov export and its receipt. Shaped like the real export (see
// fixtures/llvm-cov-export.sample.json) so a schema change in llvm-cov shows up
// in the sample test, not only here.

/** `[count, covered]` for the three dimensions the gate reads. */
export interface FileCounts {
  readonly lines: readonly [number, number];
  readonly functions?: readonly [number, number];
  readonly regions?: readonly [number, number];
}

export const RUST_ROOT = '/work/mangostudio';
export const RUST_SHA = 'c'.repeat(40);

const counts = ([count, covered]: readonly [number, number]) => ({ count, covered });

/**
 * An export over `files` (repository-relative path -> counts), as the runner
 * would write it with the checkout at `RUST_ROOT`.
 * // Usage: exportJson({ 'crates/a/src/lib.rs': { lines: [10, 8] } })
 */
export const exportJson = (
  files: Readonly<Record<string, FileCounts>>,
  manifestPath = `${RUST_ROOT}/Cargo.toml`
): string =>
  JSON.stringify({
    type: 'llvm.coverage.json.export',
    version: '3.1.0',
    cargo_llvm_cov: { version: '0.9.1', manifest_path: manifestPath },
    data: [
      {
        files: Object.entries(files).map(([path, file]) => ({
          filename: path.startsWith('/') ? path : `${RUST_ROOT}/${path}`,
          summary: {
            lines: counts(file.lines),
            functions: counts(file.functions ?? [2, 2]),
            regions: counts(file.regions ?? [4, 4]),
          },
        })),
        totals: {},
      },
    ],
  });

/** The receipt the job writes. // Usage: receiptJson(RUST_SHA, 0) */
export const receiptJson = (sourceSha: string, testsExitCode: number): string =>
  JSON.stringify({ sourceSha, testsExitCode });

/** Two crates, each with two files, all partly covered. */
export const TWO_CRATE_FILES: Readonly<Record<string, FileCounts>> = {
  'crates/alpha/src/lib.rs': { lines: [10, 8], functions: [2, 2], regions: [4, 3] },
  'crates/alpha/src/util.rs': { lines: [10, 5], functions: [3, 1], regions: [6, 2] },
  'crates/beta/src/lib.rs': { lines: [40, 20], functions: [4, 4], regions: [8, 8] },
  'crates/beta/src/more.rs': { lines: [10, 10], functions: [1, 1], regions: [2, 2] },
};
export const TWO_CRATE_ROOTS = ['crates/alpha', 'crates/beta'] as const;
