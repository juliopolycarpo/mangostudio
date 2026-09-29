// Decides what the collector knows about Rust coverage before it looks at any
// data: was the CI job supposed to run at all, did it, and where are its files.
//
//   relevant == 'false'        unsupported  the rust lane was proven irrelevant
//                                           for this change, so nothing was
//                                           measured on purpose. Not a gap: an
//                                           `unavailable` here would make every
//                                           docs-only PR `incomplete`.
//   no dir, no job result      unsupported  a local run: coverage comes from CI only
//   no dir, job result set     unavailable  the job was due and delivered nothing
//                                           (failed, canceled, skipped, or no artifact)
//   dir                        resolveRustCoverage over the files found in it

import { join } from 'node:path';

import { producerAbsence } from '../collect/fragment';
import type { CoverageSummary } from '../model/metrics';
import { absentFromProducer, type Measurement, unavailable, unsupported } from '../model/states';
import { type CrateCoverage, resolveRustCoverage } from './resolve';

export const EXPORT_FILE = 'llvm-cov.json';
export const RECEIPT_FILE = 'receipt.json';

/** Hard bound on the export the collector will read; the real one is ~110 KB. */
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;

/** How the workflow describes the Rust coverage job to the collector. */
export interface RustCoverageSource {
  /** Directory holding the job's artifact, or null when none was downloaded. */
  readonly dir: string | null;
  /** `needs.changes.outputs.rust` (`'true'` / `'false'`); empty outside CI. */
  readonly relevant: string | undefined;
  /** `needs.rust-coverage.result`; empty outside CI. */
  readonly result: string | undefined;
}

/** Reads a text file; null when it does not exist. Injectable so tests use a named fake. */
export type ReadText = (path: string) => Promise<string | null>;

/** Reads from disk, refusing anything above `MAX_EXPORT_BYTES`. */
export const readBoundedText: ReadText = async (path) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  if (file.size > MAX_EXPORT_BYTES) {
    throw new Error(`${path} is ${file.size} bytes; expected at most ${MAX_EXPORT_BYTES}`);
  }
  return file.text();
};

const everyCrate =
  (cell: Measurement<CoverageSummary>): CrateCoverage =>
  () =>
    cell;

/**
 * The per-crate coverage the collector should report.
 * // Usage: const coverage = await rustCoverageInputs({ dir: './qa-rust-coverage', relevant: 'true', result: 'success' }, sha, ['crates/mango-protocol'], readBoundedText)
 */
export const rustCoverageInputs = async (
  source: RustCoverageSource,
  sourceSha: string,
  crateRoots: readonly string[],
  readText: ReadText
): Promise<CrateCoverage> => {
  if (source.relevant === 'false') {
    return everyCrate(
      unsupported('rust coverage not run: no Rust-relevant path changed in this change')
    );
  }
  const cause = producerAbsence(source.result);
  if (source.dir === null) {
    return everyCrate(
      cause === null
        ? unsupported('rust coverage is produced only by the CI rust-coverage job; not run locally')
        : absentFromProducer('rust coverage artifact', cause)
    );
  }
  try {
    const evidence = {
      export: await readText(join(source.dir, EXPORT_FILE)),
      receipt: await readText(join(source.dir, RECEIPT_FILE)),
    };
    return resolveRustCoverage(evidence, sourceSha, crateRoots, cause ?? 'missing');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return everyCrate(unavailable(`rust coverage artifact unreadable: ${message}`));
  }
};
