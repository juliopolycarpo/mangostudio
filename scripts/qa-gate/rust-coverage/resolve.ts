// Turns what the CI Rust coverage job left behind (an llvm-cov export and a
// receipt) into one explicit coverage measurement per crate. Nothing here runs
// cargo: it only reads the two files, and every way they can be wrong lands on
// `unavailable`, `stale` or `partial`. A crate is never `measured` from data
// that could hide a lost profile, and never reads as a zero.
//
//   no export / no receipt            unavailable  (the producer's fate is the reason)
//   unreadable or malformed file      unavailable
//   receipt for another commit        stale
//   crate has no file in the export   unavailable  (no profile data for it)
//   crate ran but executed 0 lines    unavailable  (its profile data was lost)
//   the test run exited non-zero      partial      (only the binaries that ran contributed)

import { posix } from 'node:path';

import type { CoverageSummary } from '../model/metrics';
import {
  absentFromProducer,
  type Measurement,
  measured,
  type ProducerAbsence,
  partial,
  stale,
  unavailable,
} from '../model/states';
import { coverageBucket } from '../parse-lcov';
import {
  type LlvmCovExport,
  parseLlvmCovExport,
  parseRustCoverageReceipt,
} from './llvm-cov-export';

/** The raw text of the two files the job uploads; null when a file was not there. */
export interface RustCoverageEvidence {
  readonly export: string | null;
  readonly receipt: string | null;
}

/** Coverage of the crate rooted at a repository-relative directory. */
export type CrateCoverage = (crateRoot: string) => Measurement<CoverageSummary>;

interface FileCounts {
  readonly lines: { readonly count: number; readonly covered: number };
  readonly functions: { readonly count: number; readonly covered: number };
  readonly regions: { readonly count: number; readonly covered: number };
}

/** Every crate gets the same cell: what went wrong applies to the whole run. */
const forEveryCrate =
  (cell: Measurement<CoverageSummary>): CrateCoverage =>
  () =>
    cell;

/**
 * The repository-relative path of an export record, or null when the file is
 * outside the measured checkout (registry sources, the toolchain).
 */
const relativePath = (filename: string, checkoutRoot: string): string | null => {
  const relative = posix.relative(checkoutRoot, filename);
  return relative === '' || relative.startsWith('..') || posix.isAbsolute(relative)
    ? null
    : relative;
};

const isUnder = (path: string, root: string): boolean => path.startsWith(`${root}/`);

/** Files owned by `root`: those under it and under no deeper crate root. */
const filesOf = (
  files: ReadonlyMap<string, FileCounts>,
  root: string,
  crateRoots: readonly string[]
): FileCounts[] => {
  const deeper = crateRoots.filter((other) => other !== root && isUnder(other, root));
  return [...files.entries()]
    .filter(([path]) => isUnder(path, root) && !deeper.some((other) => isUnder(path, other)))
    .map(([, counts]) => counts);
};

type Dimension = keyof FileCounts;

const sum = (files: readonly FileCounts[], dimension: Dimension) => {
  const total = files.reduce((all, file) => all + file[dimension].count, 0);
  const covered = files.reduce((all, file) => all + file[dimension].covered, 0);
  return { total, covered };
};

const summarize = (root: string, files: readonly FileCounts[]): Measurement<CoverageSummary> => {
  const lines = sum(files, 'lines');
  const functions = sum(files, 'functions');
  const regions = sum(files, 'regions');
  for (const [name, bucket] of Object.entries({ lines, functions, regions })) {
    if (bucket.covered > bucket.total) {
      return unavailable(
        `${root}: ${name} covered=${bucket.covered} total=${bucket.total} is inconsistent; expected covered <= total`
      );
    }
  }
  if (lines.total === 0) {
    return unavailable(
      `${root}: ${files.length} file(s) in the llvm-cov export but 0 instrumented lines; expected at least one`
    );
  }
  if (lines.covered === 0) {
    return unavailable(
      `${root}: 0 of ${lines.total} instrumented lines were executed; the crate's profile data is missing, expected its tests to execute at least one line`
    );
  }
  return measured({
    lines: coverageBucket(lines.total, lines.covered),
    functions: coverageBucket(functions.total, functions.covered),
    regions: coverageBucket(regions.total, regions.covered),
    // Not collected: `cargo llvm-cov` is run without branch coverage, and
    // libtest doctests are not instrumented, so neither has a number to report.
    statements: null,
    branches: null,
  });
};

const indexByPath = (report: LlvmCovExport): Map<string, FileCounts> => {
  const root = posix.dirname(report.cargo_llvm_cov.manifest_path);
  const files = new Map<string, FileCounts>();
  for (const file of report.data.flatMap((bundle) => bundle.files)) {
    const path = relativePath(file.filename, root);
    if (path !== null) files.set(path, file.summary);
  }
  return files;
};

/**
 * Resolve the per-crate coverage of one instrumented run measured at `sourceSha`.
 * `cause` is why the files are absent when they are (the job's own result).
 * // Usage: resolveRustCoverage({ export: text, receipt }, sha, ['crates/mango-protocol'])('crates/mango-protocol')
 */
export const resolveRustCoverage = (
  evidence: RustCoverageEvidence,
  sourceSha: string,
  crateRoots: readonly string[],
  cause: ProducerAbsence = 'missing'
): CrateCoverage => {
  if (evidence.export === null) {
    return forEveryCrate(absentFromProducer('llvm-cov export', cause));
  }
  if (evidence.receipt === null) {
    return forEveryCrate(
      unavailable(
        'rust coverage receipt not delivered: cannot tell whether the instrumented test run finished'
      )
    );
  }
  const receipt = parseRustCoverageReceipt(evidence.receipt);
  if ('error' in receipt) return forEveryCrate(unavailable(receipt.error));
  const report = parseLlvmCovExport(evidence.export);
  if ('error' in report) return forEveryCrate(unavailable(report.error));
  if (receipt.value.sourceSha !== sourceSha) {
    return forEveryCrate(
      stale(`rust coverage measured ${receipt.value.sourceSha}, envelope measures ${sourceSha}`)
    );
  }

  const files = indexByPath(report.value);
  const exitCode = receipt.value.testsExitCode;
  return (root) => {
    const owned = filesOf(files, root, crateRoots);
    if (owned.length === 0) {
      return unavailable(
        `${root}: no instrumented source file in the llvm-cov export; expected the crate's tests to leave profile data`
      );
    }
    const cell = summarize(root, owned);
    if (cell.state !== 'measured' || exitCode === 0) return cell;
    return partial(cell.value, [
      `instrumented test run exited ${exitCode}: only the test binaries that ran contributed profile data, so coverage is a lower bound`,
    ]);
  };
};
