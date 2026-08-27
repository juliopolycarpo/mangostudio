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

export type TestLaneId =
  | 'root'
  | 'api-unit'
  | 'api-integration'
  | 'shared'
  | 'runtime'
  | 'frontend';

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
  /**
   * Repo-relative LCOV slice this lane writes, set only where a workspace owns
   * more than one lane and the slices have to be merged into the single file
   * `SHARDED_LCOV_PATHS` names. A single-lane workspace writes that file
   * directly from its own coverage dir, with nothing to merge.
   */
  readonly lcovPath?: string;
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
 * For an *isolated* sharded lane these are load-bearing for correctness, not
 * just for speed. Without them `--shard=i/N` is a round-robin over the
 * alphabetical file list, so all N shards derive the same partition
 * independently and cannot disagree. With them the partition is a function of
 * a *shared file*, and N shards that read different bytes will not cover the
 * file set between them — some files run twice, others not at all, and every
 * shard still exits 0. The duplicate-claim check in `mergeLaneSlices`
 * (`scripts/ci/merge-timings-shards.ts`) is what turns that into a failure.
 *
 * An *unisolated* sharded lane inverts that trade, which is why
 * `api-integration` opts out — see the lane entry below.
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
  // The api workspace is two lanes, not one, because its two suites need
  // opposite isolation settings. Unit keeps `--parallel=1` (= one worker,
  // `--isolate`): dropping isolation there costs 172 failures (measured; see
  // docs/reference/testing.md). Integration runs with no `--parallel` at all —
  // it passes without isolation by design, and Bun's isolate machinery is what
  // intermittently wedges the whole invocation in CI (oven-sh/bun#39709 — the
  // runner never exits, or `spawnSync` stalls inside isolate workers), so the
  // spawn-heavy integration files stay out of it until oven-sh/bun#38008
  // ships. Each lane writes its own LCOV slice, and the api `test:coverage`
  // script delegates to scripts/ci/run-workspace-coverage.ts, which runs both
  // lanes whatever the earlier one did and merges the slices into the single
  // `coverage/api/lcov.info` the coverage readers expect. That is one more merge hop than the other
  // workspaces take, and merge-lcov-shards.ts is not strictly associative —
  // its "shape" record is whichever input covered the most lines, so a
  // pre-merged pair can win a shape a flat merge would have given to a
  // per-shard record. The drift is the same kind and order the sharded merge
  // already documents (lines flat, functions approximate), not a new class of
  // error.
  {
    id: 'api-unit',
    workspace: 'api',
    sharded: true,
    junitPath: `${JUNIT_DIR}/api-unit.xml`,
    timingsPath: `${TIMINGS_DIR}/api-unit.json`,
    lcovPath: '.mango/artifacts/coverage/api-unit/lcov.info',
    manifest: 'apps/api/package.json',
    coverageScript: 'test:coverage:unit',
  },
  {
    id: 'api-integration',
    workspace: 'api',
    sharded: true,
    junitPath: `${JUNIT_DIR}/api-integration.xml`,
    // Deliberately no timingsPath, and the only lane that opts out for this
    // reason. This is the one lane that is both sharded and unisolated: its
    // files share a module graph, so what a shard runs beside decides what it
    // inherits — the in-memory database, `mock.module` registrations, the
    // memoized `getAuth()`. A timings-balanced partition is a function of a
    // file that is refreshed every run and cached across runs, so it rotates:
    // a file's companions change from run to run and a leak surfaces as an
    // intermittent failure in a file nobody touched. Round-robin over the
    // alphabetical list is derived by each shard from the file set alone, so
    // the same commit always produces the same partition and a leak is
    // reproducible from the SHA.
    //
    // Measured on the 101-file lane (Bun 1.4.0, 85.3s total): the critical
    // shard goes 20.3s -> 29.9s at N=8. Cheap, because one file
    // (`spawn-runtime-child`, 20.3s) is 24% of the lane and is the floor under
    // any split — the balancing had little left to win. Determinism verified:
    // two no-timings runs produced byte-identical partitions, union 101 files,
    // no duplicates.
    //
    // Note what this does *not* buy: the partition is stable for a given file
    // set, not across them. Adding or deleting an integration file shifts the
    // whole stride. Detection of the leak class itself is the randomized-order
    // nightly's job (`.github/workflows/randomized-order-nightly.yml`).
    lcovPath: '.mango/artifacts/coverage/api-integration/lcov.info',
    manifest: 'apps/api/package.json',
    coverageScript: 'test:coverage:integration',
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
    // Measured 2026-08-22 on the full 168-file suite: 81.78 / 77.33 / 81.92 /
    // 54.27 (Bun's own instrumentation — not comparable to the retired
    // istanbul figures 76.1 / 68.08 / 72.84 / 78.78). The floors are unchanged
    // from the 2026-08-21 measurement of 82.35 / 77.53 / 82.39 / 54.45, which
    // set them ~1pt below it for run-to-run LCOV jitter; dropping
    // `src/lib/utils.ts` and `src/utils/model-utils.ts` from
    // `coveragePathIgnorePatterns` and covering `build.ts` moved the reported
    // figures down within that headroom rather than through it. A miss fails
    // the lane's own CI job — see enforce-coverage-thresholds.ts.
    coverageThresholds: { lines: 81, functions: 76, statements: 81, branches: 53 },
  },
];

/**
 * Workspaces whose LCOV the merge job stages back into the checkout from the
 * per-job artifacts, keyed by workspace. The sharded lanes need the real
 * merge in `merge-lcov-shards.ts`; the frontend contributes exactly one file
 * from its own job, for which the merge degenerates to a copy. The api entry
 * is one path even though the workspace is two lanes: its `test:coverage`
 * script merges the per-lane slices into this file before the shard uploads.
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
