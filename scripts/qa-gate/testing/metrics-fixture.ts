// Test-only builders for Metrics documents. Lives outside the test files so
// the renderer and verdict suites share one fixture without cross-importing
// test modules.

import type { CiDurationComparison, CiJobDuration, CiRunDurations } from '../ci-durations';
import type {
  Component,
  ComponentKind,
  CoverageSummary,
  LocBucket,
  LocStats,
  Metrics,
} from '../collect/types';
import type { Provenance } from '../model/envelope';
import type { LaneEntry, LaneResult } from '../model/lanes';
import { type Measurement, measured, unsupported } from '../model/states';
import { lanesForComponentRoot } from '../results/lane-components';

/** Build a coverage summary where every bucket sits at `pct`. // Usage: makeCoverageSummary(82) */
export const makeCoverageSummary = (pct = 80): CoverageSummary => ({
  lines: { total: 100, covered: pct, pct },
  statements: { total: 100, covered: pct, pct },
  functions: { total: 100, covered: pct, pct },
  branches: { total: 100, covered: pct, pct },
});

const emptyLocBucket = (): LocBucket => ({ files: 0, code: 0, comment: 0, blank: 0, total: 0 });

/** Build LoC stats with `code` production lines in one file. // Usage: makeLocStats(120) */
export const makeLocStats = (code = 100): LocStats => ({
  production: { files: 1, code, comment: 0, blank: 0, total: code },
  test: emptyLocBucket(),
  generated: emptyLocBucket(),
  fixture: emptyLocBucket(),
  config: emptyLocBucket(),
  docs: emptyLocBucket(),
});

/** A fully delivered lane result: 100 passing tests over 8 complete shards. // Usage: makeLaneResult({ failed: 2 }) */
export const makeLaneResult = (overrides: Partial<LaneResult> = {}): LaneResult => ({
  passed: 100,
  failed: 0,
  skipped: 0,
  todo: 0,
  recovered: 0,
  failedFiles: 0,
  shards: { expected: 8, complete: 8 },
  nonZeroExits: 0,
  timedOut: 0,
  retriedJobs: 0,
  headlines: [],
  recoveredFailures: [],
  ...overrides,
});

/**
 * Healthy lane entries for every lane the registry gives `root`, with per-lane
 * overrides. // Usage: makeLanes('apps/api', { 'api-unit': unavailable('shard 3 lost') })
 */
export const makeLanes = (
  root: string,
  overrides: Readonly<Record<string, Measurement<LaneResult>>> = {}
): LaneEntry[] =>
  lanesForComponentRoot(root).map((lane) => ({
    id: lane.id,
    tests: overrides[lane.id] ?? measured(makeLaneResult()),
  }));

const COMPONENT_NAMES: Readonly<Record<string, readonly [ComponentKind, string]>> = {
  'apps/frontend': ['workspace', '@mangostudio/frontend'],
  'apps/api': ['workspace', '@mangostudio/api'],
  'apps/shared': ['workspace', '@mangostudio/shared'],
  'crates/mango-protocol': ['crate', 'mango-protocol'],
};

/**
 * Build a healthy component. Coverage and type-check are measured for the
 * three `apps/*` lanes and `unsupported` elsewhere, as the collector reports.
 * // Usage: makeComponent('apps/api', { tsErrors: measured(2) })
 */
export const makeComponent = (root: string, overrides: Partial<Component> = {}): Component => {
  const [kind, name] = COMPONENT_NAMES[root] ?? ['workspace', root.split('/').at(-1) ?? root];
  const onLane = root.startsWith('apps/');
  const notOnLane = <T>(what: string): Measurement<T> =>
    unsupported(`${what} is not wired for ${root}`);
  return {
    id: `${kind}:${name}`,
    kind,
    name,
    root,
    loc: measured(makeLocStats()),
    coverage: onLane ? measured(makeCoverageSummary()) : notOnLane('coverage'),
    tsErrors: onLane ? measured(0) : notOnLane('type-check'),
    lanes: makeLanes(root),
    ...overrides,
  };
};

/** The default healthy component set: three JS lanes plus one Rust crate. */
const DEFAULT_COMPONENT_ROOTS = [
  'apps/frontend',
  'apps/api',
  'apps/shared',
  'crates/mango-protocol',
] as const;

/**
 * Default components with per-root overrides.
 * // Usage: makeComponents({ 'apps/api': { coverage: unavailable('lcov missing') } })
 */
export const makeComponents = (
  patches: Readonly<Record<string, Partial<Component>>> = {}
): Component[] => DEFAULT_COMPONENT_ROOTS.map((root) => makeComponent(root, patches[root]));

/** Provenance for an envelope measured at `sourceSha`. // Usage: makeProvenance(headSha) */
export const makeProvenance = (sourceSha: string): Provenance => ({
  sourceSha,
  producer: { name: 'mangostudio/qa-gate-collect', version: '0.1.1' },
  runId: 4242,
  runAttempt: 1,
});

/** Build a healthy Metrics document; override fields per test. // Usage: makeMetrics('sha', { circularDeps: measured(2) }) */
export const makeMetrics = (sha: string, overrides: Partial<Metrics> = {}): Metrics => ({
  sha,
  generatedAt: '2026-05-16T00:00:00.000Z',
  components: makeComponents(),
  duplication: measured({ clones: 0, duplicatedLines: 0, percentage: 0 }),
  circularDeps: measured(0),
  frontendBundle: measured({
    files: 4,
    rawBytes: 400_000,
    gzipBytes: 100_000,
    jsGzipBytes: 80_000,
    cssGzipBytes: 18_000,
    htmlGzipBytes: 2_000,
  }),
  dependencies: measured({
    workspaceManifests: 5,
    directDependencies: 42,
    directDevDependencies: 30,
    lockedPackages: 250,
  }),
  tests: measured({
    exitCode: 0,
    durationSeconds: 240,
    passed: 1_157,
    root: 4,
    frontend: 230,
    api: 770,
    shared: 96,
  }),
  tooling: measured({ checkExitCode: 0, failedTasks: [] }),
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
