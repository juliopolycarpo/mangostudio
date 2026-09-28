// Typed accessors that pull a fully measured metric out of a Metrics document
// (or null when it is missing or in any other state), plus shared render
// constants. Only `measured` values reach a delta: a `partial` value is a
// lower bound and `stale`/`unavailable`/`unsupported` carry none.

import type {
  BundleStats,
  Component,
  CoverageSummary,
  DependencyStats,
  DuplicationStats,
  LocBucket,
  LocStats,
  Measurement,
  Metrics,
  TestSuiteStats,
  ToolingCheckStats,
} from '../collect/types';
import { measuredValue } from '../model/states';
import type { CoverageBucket } from '../parse-lcov';
import { inlineCode, NA } from './format';

export const COVERAGE_KEYS = ['lines', 'statements', 'functions', 'branches'] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];

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

export const getTooling = (metrics: Metrics | null): ToolingCheckStats | null =>
  measuredValue(metrics?.tooling);

/**
 * Aggregate line coverage across every component that has a coverage lane
 * (covered/total + pct). `unsupported` components are skipped: they have no
 * lane, and counting them would switch the drop guard off for good. Any other
 * non-measured state makes the aggregate n/a rather than a lower number.
 * // Usage: getTotalLineCoverage(head)?.pct
 */
export const getTotalLineCoverage = (metrics: Metrics | null): CoverageBucket | null => {
  if (!metrics) return null;
  let covered = 0;
  let total = 0;
  let lanes = 0;
  for (const component of metrics.components) {
    if (component.coverage.state === 'unsupported') continue;
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

/** The per-component measurements of a document as `[name, cell]`. */
export const componentMeasurements = (metrics: Metrics): NamedMeasurement[] =>
  metrics.components.flatMap((component) => [
    [`coverage/${component.root}`, component.coverage] as const,
    [`tsErrors/${component.root}`, component.tsErrors] as const,
    [`loc/${component.root}`, component.loc] as const,
  ]);

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
