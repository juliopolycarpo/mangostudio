// Typed accessors that pull a fully measured metric out of a Metrics document
// (or null when it is missing or in any other state), plus shared render
// constants. Only `measured` values reach a delta: a `partial` value is a
// lower bound and `stale`/`unavailable`/`unsupported` carry none.

import type {
  BundleStats,
  Component,
  ComponentKind,
  CoverageSummary,
  DependencyStats,
  DuplicationStats,
  LaneResult,
  LocBucket,
  LocStats,
  Measurement,
  Metrics,
  TestSuiteStats,
  ToolingCheckStats,
} from '../collect/types';
import { measuredValue, presentValue } from '../model/states';
import type { CoverageBucket } from '../parse-lcov';
import { lanesForComponentRoot } from '../results/lane-components';
import { inlineCode, NA } from './format';

const COVERAGE_KEYS = ['lines', 'statements', 'functions', 'branches', 'regions'] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];

const JS_COVERAGE_KEYS: readonly CoverageKey[] = ['lines', 'statements', 'functions', 'branches'];
const RUST_COVERAGE_KEYS: readonly CoverageKey[] = ['lines', 'functions', 'regions'];

/**
 * The coverage dimensions a component kind's producer defines, in row order.
 * A JS workspace has no regions; a crate has no statements and, with
 * `cargo llvm-cov` run without branch data, no branches: listing a row that
 * can never hold a number would only add `n/a` noise.
 * // Usage: coverageKeysFor('crate') // ['lines', 'functions', 'regions']
 */
export const coverageKeysFor = (kind: ComponentKind): readonly CoverageKey[] =>
  kind === 'crate' ? RUST_COVERAGE_KEYS : JS_COVERAGE_KEYS;

/** Row id for the aggregate across every component. */
export const TOTAL = 'total';

/** Table label of a component: its repository-relative root (pattern-constrained by the schema). */
export const componentLabel = (component: Pick<Component, 'root'>): string => component.root;

/**
 * Components present on either side: head order first, then base-only ones, so
 * a component added or removed by the change still gets a row.
 * // Usage: componentRows(base, head).map((component) => component.id)
 */
export const componentRows = (base: Metrics | null, head: Metrics | null): Component[] => {
  const rows = [...(head?.components ?? [])];
  for (const component of base?.components ?? []) {
    if (!rows.some((row) => row.id === component.id)) rows.push(component);
  }
  return rows;
};

export const findComponent = (metrics: Metrics | null, id: string): Component | null =>
  metrics?.components.find((component) => component.id === id) ?? null;

const addBuckets = (a: LocBucket, b: LocBucket): LocBucket => ({
  files: a.files + b.files,
  code: a.code + b.code,
  comment: a.comment + b.comment,
  blank: a.blank + b.blank,
  total: a.total + b.total,
});

/**
 * Authored source: production plus test files. Generated, fixture, config and
 * docs lines are collected in the envelope but are not part of this headline.
 * // Usage: sourceLoc(stats).code
 */
const sourceLoc = (stats: LocStats): LocBucket => addBuckets(stats.production, stats.test);

/**
 * Source LoC summed over every component; null unless all of them were fully
 * measured, so a partial or failed component can never shrink the total.
 * // Usage: getTotalLoc(head)?.code
 */
const getTotalLoc = (metrics: Metrics | null): LocBucket | null => {
  if (!metrics) return null;
  let total: LocBucket = { files: 0, code: 0, comment: 0, blank: 0, total: 0 };
  for (const component of metrics.components) {
    const stats = measuredValue(component.loc);
    if (!stats) return null;
    total = addBuckets(total, sourceLoc(stats));
  }
  return total;
};

/** Source LoC of one component (or `TOTAL`), only when fully measured. */
export const getLoc = (metrics: Metrics | null, id: string): LocBucket | null => {
  if (id === TOTAL) return getTotalLoc(metrics);
  const stats = measuredValue(findComponent(metrics, id)?.loc);
  return stats ? sourceLoc(stats) : null;
};

export const getCoverageBucket = (
  summary: Measurement<CoverageSummary> | undefined,
  key: CoverageKey
): CoverageBucket | null => measuredValue(summary)?.[key] ?? null;

export const getDuplication = (metrics: Metrics | null): DuplicationStats | null =>
  measuredValue(metrics?.duplication);

export const getCircularDeps = (metrics: Metrics | null): number | null =>
  measuredValue(metrics?.circularDeps);

export const getBundle = (metrics: Metrics | null): BundleStats | null =>
  measuredValue(metrics?.frontendBundle);

export const getDependencies = (metrics: Metrics | null): DependencyStats | null =>
  measuredValue(metrics?.dependencies);

export const getTestSuite = (metrics: Metrics | null): TestSuiteStats | null =>
  measuredValue(metrics?.tests);

/**
 * The suite counters of a `measured` or `partial` run. A partial value is a
 * lower bound: use it to detect failures, never to report a complete total.
 */
export const getTestSuiteEvidence = (metrics: Metrics | null): TestSuiteStats | null =>
  presentValue(metrics?.tests);

export const getTooling = (metrics: Metrics | null): ToolingCheckStats | null =>
  measuredValue(metrics?.tooling);

/**
 * Aggregate line coverage across every JS component that has a coverage lane
 * (covered/total + pct). `unsupported` components are skipped: they have no
 * lane, and counting them would switch the drop guard off for good. Any other
 * non-measured state makes the aggregate n/a rather than a lower number.
 * Crates are never part of it: their lines come from a different tool and a
 * run that does not measure them (no Rust change) must not shift the JS total
 * the drop guard compares; each crate has its own per-crate row.
 * // Usage: getTotalLineCoverage(head)?.pct
 */
export const getTotalLineCoverage = (metrics: Metrics | null): CoverageBucket | null => {
  if (!metrics) return null;
  let covered = 0;
  let total = 0;
  let lanes = 0;
  for (const component of metrics.components) {
    if (component.kind === 'crate' || component.coverage.state === 'unsupported') continue;
    const bucket = getCoverageBucket(component.coverage, 'lines');
    if (!bucket) return null;
    lanes++;
    covered += bucket.covered;
    total += bucket.total;
  }
  if (lanes === 0 || total === 0) return null;
  // Match parse-lcov's two-decimal pct rounding so deltas compare cleanly.
  return { covered, total, pct: Number(((covered / total) * 100).toFixed(2)) };
};

/**
 * TypeScript errors summed over components that have a type-check; null when
 * any of those was not measured.
 * // Usage: sumTsErrors(head)
 */
export const sumTsErrors = (metrics: Metrics | null): number | null => {
  if (!metrics) return null;
  let sum = 0;
  let checked = 0;
  for (const component of metrics.components) {
    if (component.tsErrors.state === 'unsupported') continue;
    const errors = measuredValue(component.tsErrors);
    if (errors === null) return null;
    checked++;
    sum += errors;
  }
  return checked === 0 ? null : sum;
};

type NamedMeasurement = readonly [string, Measurement<unknown>];

/** The per-component measurements of a document as `[name, cell]`, lane results included. */
export const componentMeasurements = (metrics: Metrics): NamedMeasurement[] =>
  metrics.components.flatMap((component) => [
    [`coverage/${component.root}`, component.coverage] as const,
    [`tsErrors/${component.root}`, component.tsErrors] as const,
    [`loc/${component.root}`, component.loc] as const,
    ...(component.lanes ?? []).map(
      (lane) => [`lanes/${component.root}/${lane.id}`, lane.tests] as const
    ),
  ]);

/** One lane of one component; `cell` is null when the document carries no entry for it. */
export interface LaneRow {
  readonly component: Component;
  readonly laneId: string;
  readonly cell: Measurement<LaneResult> | null;
}

/**
 * The lanes of every component: the ones the lane registry says the component
 * owns (a missing entry is a null cell, so absence is visible) followed by any
 * recorded lane the registry does not know.
 * // Usage: laneRows(head).filter((row) => row.cell === null)
 */
export const laneRows = (metrics: Metrics | null): LaneRow[] =>
  (metrics?.components ?? []).flatMap((component) => {
    const recorded = new Map((component.lanes ?? []).map((lane) => [lane.id, lane.tests]));
    const expected: string[] = lanesForComponentRoot(component.root).map((lane) => lane.id);
    const ids = [...expected, ...[...recorded.keys()].filter((id) => !expected.includes(id))];
    return ids.map((laneId) => ({ component, laneId, cell: recorded.get(laneId) ?? null }));
  });

/** Outcome counts summed over a set of lanes, with whether every lane was fully measured. */
export interface LaneTally {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
  readonly recovered: number;
  /** True only when at least one lane exists and every one was `measured`. */
  readonly complete: boolean;
  /** Lanes that contributed a value (measured or partial). */
  readonly withValue: number;
}

/**
 * Sum lane cells. Counts from a `partial` lane are included as a lower bound and
 * flip `complete` to false; an unavailable or absent lane adds nothing and does
 * too, so a total can never read as complete over missing lanes.
 * // Usage: tallyLanes(laneRows(head).map((row) => row.cell))
 */
export const tallyLanes = (cells: readonly (Measurement<LaneResult> | null)[]): LaneTally => {
  const tally = { passed: 0, failed: 0, skipped: 0, todo: 0, recovered: 0, withValue: 0 };
  for (const cell of cells) {
    const lane = presentValue(cell);
    if (!lane) continue;
    tally.passed += lane.passed;
    tally.failed += lane.failed;
    tally.skipped += lane.skipped;
    tally.todo += lane.todo;
    tally.recovered += lane.recovered;
    tally.withValue++;
  }
  return {
    ...tally,
    complete: cells.length > 0 && cells.every((cell) => cell?.state === 'measured'),
  };
};

/** The repository-wide measurements of a document as `[name, cell]`. */
export const globalMeasurements = (metrics: Metrics): NamedMeasurement[] => [
  ['tests', metrics.tests],
  ['tooling', metrics.tooling],
  ['duplication', metrics.duplication],
  ['circularDeps', metrics.circularDeps],
  ['frontendBundle', metrics.frontendBundle],
  ['dependencies', metrics.dependencies],
];

/** Format the repo-check status cell: pass / FAIL(code) plus failed tasks. */
export const renderToolingStatus = (stats: ToolingCheckStats | null): string => {
  if (!stats) return NA;
  const status = stats.checkExitCode === 0 ? 'pass' : `FAIL (${stats.checkExitCode})`;
  if (stats.failedTasks.length === 0) return status;
  return `${status}: ${stats.failedTasks.map(inlineCode).join(', ')}`;
};
