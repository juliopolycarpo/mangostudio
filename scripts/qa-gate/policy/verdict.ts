// The verdict policy: a pure function from the base and head metrics to one of
// three outcomes, kept apart from the wording that renders it.
//
//   pass        every head metric was measured, nothing regressed, and the
//               comparison against base was either complete or impossible
//               because there is no base at all (a first run, a forked PR)
//   fail        something concrete regressed: a failing test lane or suite, a
//               type error, a coverage drop, ...
//   incomplete  evidence is missing: a head metric or lane that is partial,
//               stale, unavailable or absent, or a base that exists but was
//               itself only partly measured. Never `pass`.
//
// The rule that shapes everything below: absence of a signal is not a healthy
// signal. Comparative items return null both for "fine" and for "a side was
// missing", so missing data is detected separately and decides the outcome.

import type { Metrics } from '../collect/types';
import { needsAttention } from '../model/states';
import {
  componentMeasurements,
  getBundle,
  getCircularDeps,
  getDuplication,
  getTestSuiteEvidence,
  getTooling,
  getTotalLineCoverage,
  globalMeasurements,
  sumTsErrors,
} from '../render/access';
import { formatBytes, inlineCode } from '../render/format';
import { laneFailureItem, missingLanes, recoveredFailuresNote } from './lanes';

export type VerdictOutcome = 'pass' | 'fail' | 'incomplete';

/** How far the base↔head comparison could be made. */
type BaseComparison =
  /** Both sides carried every compared metric, fully measured. */
  | 'complete'
  /** No base document at all: a first run, a forked PR, no baseline yet. */
  | 'base-absent'
  /** A base exists but a compared metric in it is partial, stale or unavailable. */
  | 'base-incomplete'
  /** A compared metric could not be read on one side for a reason the states do not name. */
  | 'partial-comparison';

export interface Verdict {
  readonly outcome: VerdictOutcome;
  /** Head measurements that are missing or not fully measured, by name. */
  readonly gaps: readonly string[];
  /** Concrete head-side regressions and failures, worded for the headline. */
  readonly regressions: readonly string[];
  /** Base measurements that were compared but not fully measured, by name. */
  readonly baseGaps: readonly string[];
  readonly comparison: BaseComparison;
  /** Non-blocking observations, e.g. failures that passed on a later run. */
  readonly notes: readonly string[];
}

// Ignore sub-0.1pp percentage drift and sub-10KiB gzip growth — both are
// routine noise on unrelated changes and would make the verdict cry wolf.
const PERCENT_EPSILON_PP = 0.1;
const BUNDLE_GROWTH_THRESHOLD_BYTES = 10 * 1024;

const coverageDropItem = (base: Metrics | null, head: Metrics | null): string | null => {
  const basePct = getTotalLineCoverage(base)?.pct;
  const headPct = getTotalLineCoverage(head)?.pct;
  if (basePct == null || headPct == null) return null;
  const drop = basePct - headPct;
  if (drop < PERCENT_EPSILON_PP) return null;
  return `line coverage −${drop.toFixed(2)}pp`;
};

const duplicationItem = (base: Metrics | null, head: Metrics | null): string | null => {
  const basePct = getDuplication(base)?.percentage;
  const headPct = getDuplication(head)?.percentage;
  if (basePct == null || headPct == null) return null;
  const growth = headPct - basePct;
  if (growth < PERCENT_EPSILON_PP) return null;
  return `duplication +${growth.toFixed(2)}pp`;
};

const bundleItem = (base: Metrics | null, head: Metrics | null): string | null => {
  const baseGzip = getBundle(base)?.gzipBytes;
  const headGzip = getBundle(head)?.gzipBytes;
  if (baseGzip == null || headGzip == null) return null;
  const growth = headGzip - baseGzip;
  if (growth < BUNDLE_GROWTH_THRESHOLD_BYTES) return null;
  return `bundle gzip +${formatBytes(growth)}`;
};

/**
 * Missing evidence about the suite itself, read off the value of a `measured`
 * or `partial` suite: a run that left no exit code (no process receipt), or one
 * that exited 0 while a lane produced no results (Bun can fail to write JUnit
 * and still exit 0). Neither is a failure of a test; both mean the run cannot
 * be called healthy.
 */
const testEvidenceGaps = (head: Metrics): string[] => {
  const stats = getTestSuiteEvidence(head);
  if (!stats) return [];
  if (stats.exitCode === null) return ['tests (no process exit code)'];
  return stats.exitCode === 0 && stats.parseMiss
    ? ['tests (no readable lane results, exit 0)']
    : [];
};

/**
 * The suite-level test failure. It reads the value of a `partial` suite too: a
 * lower bound still proves a failure.
 */
const testSuiteItem = (head: Metrics | null): string | null => {
  const stats = getTestSuiteEvidence(head);
  if (!stats || stats.exitCode === null || stats.exitCode === 0) return null;
  if (stats.parseMiss) {
    return `tests failing (exit ${stats.exitCode}; no failure counts could be parsed from the log)`;
  }
  const bits = [`exit ${stats.exitCode}`];
  if (stats.errors) {
    bits.push(`${stats.errors} unhandled error${stats.errors === 1 ? '' : 's'}`);
  }
  if (stats.failed) {
    bits.push(`${stats.failed} failed`);
  }
  return `tests failing (${bits.join(', ')})`;
};

/**
 * Head-side measurements that are `unavailable`, `partial` or `stale` instead of
 * `measured`, plus lanes the registry expects that the document lacks entirely.
 *
 * A metric that fails to collect does not merely go unreported — it disarms the
 * guard built on it: a broken collector reads exactly like a healthy one.
 *
 * Head only. A base envelope is legitimately absent on a first run, on a forked
 * PR and before the first main-push baseline exists; that is `comparison`, not a
 * gap. `unsupported` is a definition ("no lane for this component"), not a
 * failure, so it never reads as uncollected — except for a lane the registry
 * says exists.
 */
const headGaps = (head: Metrics | null): string[] => {
  if (!head) return [];
  const uncollected = [...globalMeasurements(head), ...componentMeasurements(head)]
    .filter(([, cell]) => needsAttention(cell))
    .map(([name]) => name);
  return [...uncollected, ...testEvidenceGaps(head), ...missingLanes(head)];
};

/**
 * Base cells a verdict compares against; a base gap here means a comparison was
 * not made. A crate's coverage is not one of them: it is compared row by row
 * and a missing side renders n/a, so a Rust job that failed on the base commit
 * cannot make the JS comparison of an unrelated PR incomplete. The head side
 * still counts it (`headGaps`).
 */
const comparedBaseCells = (base: Metrics) => [
  ...base.components
    .filter((component) => component.kind !== 'crate')
    .map((component) => [`coverage/${component.root}`, component.coverage] as const),
  ['duplication', base.duplication] as const,
  ['frontendBundle', base.frontendBundle] as const,
  ['tests', base.tests] as const,
  ...base.components.flatMap((component) =>
    (component.lanes ?? []).map(
      (lane) => [`lanes/${component.root}/${lane.id}`, lane.tests] as const
    )
  ),
];

const baseGaps = (base: Metrics | null): string[] =>
  base
    ? comparedBaseCells(base)
        .filter(([, cell]) => needsAttention(cell))
        .map(([name]) => name)
    : [];

// True when every base↔head comparison had both sides (comparative items return
// null both for "healthy" and for "side missing").
const allComparisonsAvailable = (base: Metrics | null, head: Metrics | null): boolean =>
  getTotalLineCoverage(base) != null &&
  getTotalLineCoverage(head) != null &&
  getDuplication(base) != null &&
  getDuplication(head) != null &&
  getBundle(base) != null &&
  getBundle(head) != null;

const comparisonOf = (
  base: Metrics | null,
  head: Metrics | null,
  gaps: readonly string[]
): BaseComparison => {
  if (base === null) return 'base-absent';
  if (gaps.length > 0) return 'base-incomplete';
  return allComparisonsAvailable(base, head) ? 'complete' : 'partial-comparison';
};

/** The head-side regressions worth flagging in the headline. */
const regressionsOf = (base: Metrics | null, head: Metrics): string[] => {
  const items: string[] = [];
  const suiteItem = testSuiteItem(head);
  if (suiteItem) items.push(suiteItem);
  const laneItem = laneFailureItem(head);
  if (laneItem) items.push(laneItem);

  const tooling = getTooling(head);
  if (tooling && tooling.checkExitCode !== 0) {
    const failed =
      tooling.failedTasks.length > 0 ? `: ${tooling.failedTasks.map(inlineCode).join(', ')}` : '';
    items.push(`repo check failing${failed}`);
  }

  const tsErrors = sumTsErrors(head);
  if (tsErrors != null && tsErrors > 0) {
    items.push(`${tsErrors} TypeScript error${tsErrors === 1 ? '' : 's'}`);
  }

  const circular = getCircularDeps(head);
  if (circular != null && circular > 0) {
    items.push(`${circular} circular dependenc${circular === 1 ? 'y' : 'ies'}`);
  }

  for (const item of [
    coverageDropItem(base, head),
    duplicationItem(base, head),
    bundleItem(base, head),
  ]) {
    if (item) items.push(item);
  }
  return items;
};

/**
 * Decide the verdict for a base/head pair.
 * // Usage: evaluateVerdict(base, head).outcome // 'pass' | 'fail' | 'incomplete'
 */
export const evaluateVerdict = (base: Metrics | null, head: Metrics | null): Verdict => {
  if (!head) {
    return {
      outcome: 'incomplete',
      gaps: ['head metrics'],
      regressions: [],
      baseGaps: [],
      comparison: base === null ? 'base-absent' : 'partial-comparison',
      notes: [],
    };
  }
  const gaps = headGaps(head);
  const regressions = regressionsOf(base, head);
  const missingBase = baseGaps(base);
  const comparison = comparisonOf(base, head, missingBase);
  const note = recoveredFailuresNote(head);

  const outcome: VerdictOutcome =
    regressions.length > 0
      ? 'fail'
      : gaps.length > 0 || comparison === 'base-incomplete'
        ? 'incomplete'
        : 'pass';
  return {
    outcome,
    gaps,
    regressions,
    baseGaps: missingBase,
    comparison,
    notes: note ? [note] : [],
  };
};
