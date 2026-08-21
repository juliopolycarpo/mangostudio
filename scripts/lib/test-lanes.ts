// The test lanes a sharded run fans out into, and where each one writes its
// structured results. One lane is one runner invocation against one workspace;
// `apps/frontend` has two because its Bun and Vitest halves are separate
// processes with separate reporters.
//
// The JUnit paths here are the same strings the workspace `test:coverage`
// scripts pass to `--reporter-outfile`. `scripts/tests/test-lanes.unit.test.ts`
// reads the manifests and fails if the two ever drift apart, because a lane
// writing somewhere the collector does not read is a silently missing count,
// not an error.

import type { WorkspaceName } from './config';

export type TestLaneId = 'root' | 'api' | 'shared' | 'runtime' | 'frontend-bun' | 'frontend-vitest';

export interface TestLane {
  readonly id: TestLaneId;
  /** Workspace the lane's pass counts belong to; root scripts have no workspace. */
  readonly workspace: WorkspaceName | 'root';
  readonly runner: 'bun' | 'vitest';
  /** Repo-relative JUnit XML the lane writes. */
  readonly junitPath: string;
  /**
   * Repo-relative `--timings` file, for Bun lanes only. Vitest shards on its
   * own and does not read this format. Paths inside the file are relative to
   * the lane's own cwd, so every Bun lane needs a separate one.
   */
  readonly timingsPath?: string;
  /** Repo-relative manifest declaring the lane's coverage script. */
  readonly manifest: string;
  /** Script key inside that manifest. */
  readonly coverageScript: string;
}

export const JUNIT_DIR = '.mango/artifacts/junit';

/**
 * Where each Bun lane's `--timings` file lives.
 *
 * These are load-bearing for correctness, not just for speed. Without them
 * `--shard=i/N` is a round-robin over the alphabetical file list, so all N
 * shards derive the same partition independently and cannot disagree. With
 * them the partition is a function of a *shared file*, and N shards that read
 * different bytes will not cover the file set between them — some files run
 * twice, others not at all, and every shard still exits 0. The duplicate-claim
 * check in `mergeLaneSlices` (`scripts/ci/merge-timings-shards.ts`) is what
 * turns that into a failure.
 */
export const TIMINGS_DIR = '.mango/artifacts/timings';

export const TEST_LANES: readonly TestLane[] = [
  {
    id: 'root',
    workspace: 'root',
    runner: 'bun',
    junitPath: `${JUNIT_DIR}/root.xml`,
    // Deliberately no timingsPath. `//#test:scripts` is the one *cached* test
    // task, and a timings file is untracked, so it cannot be part of Turbo's
    // cache key — shard i would restore a `root.xml` produced when the split
    // put different files on shard i. Balancing this lane is worth 0.5s of its
    // own and 0.6s overall (measured), which does not pay for that hazard.
    manifest: 'package.json',
    coverageScript: 'test:scripts',
  },
  {
    id: 'api',
    workspace: 'api',
    runner: 'bun',
    junitPath: `${JUNIT_DIR}/api.xml`,
    timingsPath: `${TIMINGS_DIR}/api.json`,
    manifest: 'apps/api/package.json',
    coverageScript: 'test:coverage',
  },
  {
    id: 'shared',
    workspace: 'shared',
    runner: 'bun',
    junitPath: `${JUNIT_DIR}/shared.xml`,
    timingsPath: `${TIMINGS_DIR}/shared.json`,
    manifest: 'apps/shared/package.json',
    coverageScript: 'test:coverage',
  },
  {
    id: 'runtime',
    workspace: 'runtime',
    runner: 'bun',
    junitPath: `${JUNIT_DIR}/runtime.xml`,
    timingsPath: `${TIMINGS_DIR}/runtime.json`,
    manifest: 'apps/runtime/package.json',
    coverageScript: 'test:coverage',
  },
  {
    id: 'frontend-bun',
    workspace: 'frontend',
    runner: 'bun',
    junitPath: `${JUNIT_DIR}/frontend-bun.xml`,
    timingsPath: `${TIMINGS_DIR}/frontend-bun.json`,
    manifest: 'apps/frontend/package.json',
    coverageScript: 'test:coverage:bun',
  },
  {
    id: 'frontend-vitest',
    workspace: 'frontend',
    runner: 'vitest',
    junitPath: `${JUNIT_DIR}/frontend-vitest.xml`,
    manifest: 'apps/frontend/package.json',
    coverageScript: 'test:coverage:vitest',
  },
];

/**
 * Workspaces whose LCOV a shard run splits and the merge step reassembles.
 * Vitest merges its own coverage from blob reports, so `frontend/vitest` is not
 * here; `frontend/bun` is.
 */
export const SHARDED_LCOV_PATHS: Readonly<Record<string, string>> = {
  api: '.mango/artifacts/coverage/api/lcov.info',
  shared: '.mango/artifacts/coverage/shared/lcov.info',
  runtime: '.mango/artifacts/coverage/runtime/lcov.info',
  'frontend-bun': '.mango/artifacts/coverage/frontend/bun/lcov.info',
};

/** Directory each shard's Vitest run writes its blob report into. */
export const VITEST_BLOB_DIR = 'apps/frontend/.vitest-reports';

export const laneById = (id: TestLaneId): TestLane => {
  const lane = TEST_LANES.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`Unknown test lane: ${id}`);
  return lane;
};
