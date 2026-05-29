// Typed accessors that pull a successfully-collected metric out of a Metrics
// document (or null when missing/errored), plus shared render constants.

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../../lib/config';
import type {
  BundleStats,
  CoverageSummary,
  DependencyStats,
  DuplicationStats,
  Failable,
  LocBucket,
  Metrics,
  TestLaneStats,
  ToolingCheckStats,
} from '../collect/types';
import type { CoverageBucket } from '../parse-lcov';
import { NA, ok } from './format';

export const COVERAGE_KEYS = ['lines', 'statements', 'functions', 'branches'] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];

export const WORKSPACE_ORDER: readonly (WorkspaceName | 'total')[] = [
  ...ALL_WORKSPACE_NAMES,
  'total',
];

export const getCoverageBucket = (
  summary: Failable<CoverageSummary> | undefined,
  key: CoverageKey
): CoverageBucket | null => {
  if (!ok(summary)) return null;
  return summary[key] ?? null;
};

export const getLoc = (
  metrics: Metrics | null,
  workspace: WorkspaceName | 'total'
): LocBucket | null => {
  const entry = metrics?.loc?.[workspace];
  return ok(entry) ? entry : null;
};

export const getDuplication = (metrics: Metrics | null): DuplicationStats | null =>
  ok(metrics?.duplication) ? metrics.duplication : null;

export const getCircularDeps = (metrics: Metrics | null): number | null =>
  ok(metrics?.circularDeps) ? metrics.circularDeps : null;

export const getBundle = (metrics: Metrics | null): BundleStats | null =>
  ok(metrics?.frontendBundle) ? metrics.frontendBundle : null;

export const getDependencies = (metrics: Metrics | null): DependencyStats | null =>
  ok(metrics?.dependencies) ? metrics.dependencies : null;

export const getTestLane = (
  metrics: Metrics | null,
  lane: 'unit' | 'integration'
): TestLaneStats | null => (ok(metrics?.tests?.[lane]) ? metrics.tests[lane] : null);

export const getTooling = (metrics: Metrics | null): ToolingCheckStats | null =>
  ok(metrics?.tooling) ? metrics.tooling : null;

export const sumTsErrors = (metrics: Metrics | null): number | null => {
  if (!metrics) return null;
  let sum = 0;
  for (const workspace of ALL_WORKSPACE_NAMES) {
    const entry = metrics.tsErrors[workspace];
    if (!ok(entry)) return null;
    sum += entry;
  }
  return sum;
};

/** Format the repo-check status cell: pass / FAIL(code) plus failed tasks. */
export const renderToolingStatus = (stats: ToolingCheckStats | null): string => {
  if (!stats) return NA;
  const status = stats.checkExitCode === 0 ? 'pass' : `FAIL (${stats.checkExitCode})`;
  if (stats.failedTasks.length === 0) return status;
  return `${status}: ${stats.failedTasks.join(', ')}`;
};
