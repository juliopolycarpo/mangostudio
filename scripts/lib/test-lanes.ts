// The test lanes a coverage run fans out into, and where each one writes its
// structured results. One lane is one `bun test` invocation against one
// workspace.
//
// The JUnit paths here are the same strings the workspace `test:coverage`
// scripts pass to `--reporter-outfile`. `scripts/tests/test-lanes.unit.test.ts`
// reads the manifests and fails if the two ever drift apart, because a lane
// writing somewhere the collector does not read is a silently missing count,
// not an error.

import type { WorkspaceName } from './config';

export type TestLaneId = 'root' | 'api' | 'shared' | 'runtime' | 'frontend';

/**
 * Total-coverage floors, in percent, enforced by
 * `scripts/qa-gate/enforce-coverage-thresholds.ts` after the lane's run.
 *
 * They live here and not in `bunfig.toml` because Bun 1.4.0's
 * `coverageThreshold` is enforced per *file*: every file must individually
 * clear the bar, so any workspace with a legitimately uncovered file cannot
 * express a total-coverage gate through it (measured; see
 * docs/reference/testing.md's Frontend section).
 */
interface CoverageThresholds {
  readonly lines: number;
  readonly functions: number;
  readonly statements: number;
  readonly branches: number;
}

export interface TestLane {
  readonly id: TestLaneId;
  /** Workspace the lane's pass counts belong to; root scripts have no workspace. */
  readonly workspace: WorkspaceName | 'root';
  /**
   * Whether CI's shard matrix splits this lane's files with `--shard=i/N`.
   * The frontend opts out: Bun's LCOV is not union-mergeable across shards
   * (per-file `LF`/`FNF` are run-dependent), so its coverage must come from a
   * single invocation — it runs unsharded in its own CI job, parallelised
   * in-process with `--parallel` instead.
   */
  readonly sharded: boolean;
  /** Repo-relative JUnit XML the lane writes. */
  readonly junitPath: string;
  /**
   * Repo-relative `--timings` file. Paths inside the file are relative to the
   * lane's own cwd, so every lane needs a separate one.
   */
  readonly timingsPath?: string;
  /** Repo-relative manifest declaring the lane's coverage script. */
  readonly manifest: string;
  /** Script key inside that manifest. */
  readonly coverageScript: string;
  /** Present only for lanes with a total-coverage gate. */
  readonly coverageThresholds?: CoverageThresholds;
}

export const JUNIT_DIR = '.mango/artifacts/junit';

/**
 * Where each lane's `--timings` file lives.
 *
 * For sharded lanes these are load-bearing for correctness, not just for
 * speed. Without them `--shard=i/N` is a round-robin over the alphabetical
 * file list, so all N shards derive the same partition independently and
 * cannot disagree. With them the partition is a function of a *shared file*,
 * and N shards that read different bytes will not cover the file set between
 * them — some files run twice, others not at all, and every shard still exits
 * 0. The duplicate-claim check in `mergeLaneSlices`
 * (`scripts/ci/merge-timings-shards.ts`) is what turns that into a failure.
 *
 * The unsharded frontend lane keeps one too: `--timings` also balances
 * `--parallel` workers by measured wall time instead of file order.
 */
export const TIMINGS_DIR = '.mango/artifacts/timings';

export const TEST_LANES: readonly TestLane[] = [
  {
    id: 'root',
    workspace: 'root',
    sharded: true,
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
    sharded: true,
    junitPath: `${JUNIT_DIR}/api.xml`,
    timingsPath: `${TIMINGS_DIR}/api.json`,
    manifest: 'apps/api/package.json',
    coverageScript: 'test:coverage',
  },
  {
    id: 'shared',
    workspace: 'shared',
    sharded: true,
    junitPath: `${JUNIT_DIR}/shared.xml`,
    timingsPath: `${TIMINGS_DIR}/shared.json`,
    manifest: 'apps/shared/package.json',
    coverageScript: 'test:coverage',
  },
  {
    id: 'runtime',
    workspace: 'runtime',
    sharded: true,
    junitPath: `${JUNIT_DIR}/runtime.xml`,
    timingsPath: `${TIMINGS_DIR}/runtime.json`,
    manifest: 'apps/runtime/package.json',
    coverageScript: 'test:coverage',
  },
  {
    id: 'frontend',
    workspace: 'frontend',
    sharded: false,
    junitPath: `${JUNIT_DIR}/frontend.xml`,
    timingsPath: `${TIMINGS_DIR}/frontend.json`,
    manifest: 'apps/frontend/package.json',
    coverageScript: 'test:coverage',
    // Measured 2026-08-21 on the full 167-file suite: 82.35 / 77.53 / 82.39 /
    // 54.45 (Bun's own instrumentation — not comparable to the retired
    // istanbul figures 76.1 / 68.08 / 72.84 / 78.78), then floored with ~1pt
    // of headroom for run-to-run LCOV jitter. A miss fails the lane's own CI
    // job — see enforce-coverage-thresholds.ts.
    coverageThresholds: { lines: 81, functions: 76, statements: 81, branches: 53 },
  },
];

/**
 * Workspaces whose LCOV the merge job stages back into the checkout from the
 * per-job artifacts. The sharded lanes need the real merge in
 * `merge-lcov-shards.ts`; the frontend contributes exactly one file from its
 * own job, for which the merge degenerates to a copy.
 */
export const SHARDED_LCOV_PATHS: Readonly<Record<string, string>> = {
  api: '.mango/artifacts/coverage/api/lcov.info',
  shared: '.mango/artifacts/coverage/shared/lcov.info',
  runtime: '.mango/artifacts/coverage/runtime/lcov.info',
  frontend: '.mango/artifacts/coverage/frontend/lcov.info',
};

export const laneById = (id: TestLaneId): TestLane => {
  const lane = TEST_LANES.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`Unknown test lane: ${id}`);
  return lane;
};
