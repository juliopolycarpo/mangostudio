// Test-only builders for Metrics documents. Lives outside the test files so
// the renderer and verdict suites share one fixture without cross-importing
// test modules.

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
    total: { files: 3, code: 300, comment: 0, blank: 0, total: 300 },
  },
  coverage: {
    frontend: makeCoverageSummary(),
    api: makeCoverageSummary(),
    shared: makeCoverageSummary(),
  },
  tsErrors: { frontend: 0, api: 0, shared: 0 },
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
    workspaceManifests: 4,
    directDependencies: 42,
    directDevDependencies: 30,
    lockedPackages: 250,
  },
  tests: {
    unit: {
      exitCode: 0,
      passed: 1_000,
      root: 4,
      frontend: 200,
      api: 700,
      shared: 96,
    },
    integration: {
      exitCode: 0,
      passed: 100,
      root: 0,
      frontend: 30,
      api: 70,
      shared: 0,
    },
  },
  tooling: { checkExitCode: 0, failedTasks: [] },
  ...overrides,
});
