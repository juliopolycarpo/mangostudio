// Test-only builders for Metrics documents. Lives outside the test files so
// the renderer and verdict suites share one fixture without cross-importing
// test modules.

import type { CiDurationComparison, CiJobDuration, CiRunDurations } from '../ci-durations';
import type { CoverageSummary, Metrics } from '../collect/types';

/** Build a coverage summary where every bucket sits at `pct`. // Usage: makeCoverageSummary(82) */
export const makeCoverageSummary = (pct = 80): CoverageSummary => ({
  lines: { total: 100, covered: pct, pct },
  statements: { total: 100, covered: pct, pct },
  functions: { total: 100, covered: pct, pct },
  branches: { total: 100, covered: pct, pct },
});

/** Build a healthy Metrics document; override fields per test. // Usage: makeMetrics('sha', { circularDeps: 2 }) */
export const makeMetrics = (sha: string, overrides: Partial<Metrics> = {}): Metrics => ({
  sha,
  generatedAt: '2026-05-16T00:00:00.000Z',
  loc: {
    frontend: { files: 1, code: 100, comment: 0, blank: 0, total: 100 },
    api: { files: 1, code: 100, comment: 0, blank: 0, total: 100 },
    shared: { files: 1, code: 100, comment: 0, blank: 0, total: 100 },
    runtime: { files: 1, code: 100, comment: 0, blank: 0, total: 100 },
    total: { files: 4, code: 400, comment: 0, blank: 0, total: 400 },
  },
  coverage: {
    frontend: makeCoverageSummary(),
    api: makeCoverageSummary(),
    shared: makeCoverageSummary(),
    runtime: makeCoverageSummary(),
  },
  tsErrors: { frontend: 0, api: 0, shared: 0, runtime: 0 },
  duplication: { clones: 0, duplicatedLines: 0, percentage: 0 },
  circularDeps: 0,
  frontendBundle: {
    files: 4,
    rawBytes: 400_000,
    gzipBytes: 100_000,
    jsGzipBytes: 80_000,
    cssGzipBytes: 18_000,
    htmlGzipBytes: 2_000,
  },
  dependencies: {
    workspaceManifests: 5,
    directDependencies: 42,
    directDevDependencies: 30,
    lockedPackages: 250,
  },
  tests: {
    exitCode: 0,
    durationSeconds: 240,
    passed: 1_157,
    root: 4,
    frontend: 230,
    api: 770,
    shared: 96,
    runtime: 57,
  },
  tooling: { checkExitCode: 0, failedTasks: [] },
  ...overrides,
});

const CI_TIME_ORIGIN = Date.parse('2026-05-16T00:00:00.000Z');

/** Build one Actions job timing around a stable test timestamp. */
export const makeCiJob = (
  name: string,
  durationSeconds: number | null,
  overrides: Partial<CiJobDuration> & { readonly startOffsetSeconds?: number } = {}
): CiJobDuration => {
  const { startOffsetSeconds = 0, ...jobOverrides } = overrides;
  const startedAt = new Date(CI_TIME_ORIGIN + startOffsetSeconds * 1000).toISOString();
  return {
    name,
    status: durationSeconds === null ? 'in_progress' : 'completed',
    conclusion: durationSeconds === null ? null : 'success',
    startedAt,
    completedAt:
      durationSeconds === null
        ? null
        : new Date(CI_TIME_ORIGIN + (startOffsetSeconds + durationSeconds) * 1000).toISOString(),
    ...jobOverrides,
  };
};

/** Build one workflow-run timing snapshot. */
export const makeCiRun = (
  runId: number | null,
  jobs: readonly CiJobDuration[] = [],
  error: string | null = null
): CiRunDurations => ({ runId, error, jobs: [...jobs] });

/** Build base/head/previous CI timing data for renderer tests. */
export const makeCiDurations = (
  overrides: Partial<CiDurationComparison> = {}
): CiDurationComparison => ({
  base: makeCiRun(1, [makeCiJob('Test / Run tests', 240), makeCiJob('Build / Frontend', 60)]),
  head: makeCiRun(2, [makeCiJob('Test / Run tests', 280), makeCiJob('Build / Frontend', 80)]),
  previous: makeCiRun(3, [makeCiJob('Test / Run tests', 260)]),
  ...overrides,
});
