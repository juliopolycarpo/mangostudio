#!/usr/bin/env bun
// Run every coverage lane a workspace owns, then merge their LCOV slices into
// the single per-workspace file the coverage readers and the shard upload
// expect.
//
// This exists because `&&` is the wrong operator for a lane chain. The api
// workspace is two lanes — see test-lanes.ts for why their isolation settings
// have to differ — and chaining them as
// `test:coverage:unit && test:coverage:integration && <merge>` means one
// failing unit test skips the integration lane *and* the merge. The shard then
// uploads no `api-integration.xml` and no `coverage/api/lcov.info`, on exactly
// the red run someone is triaging; and when the failure is shared across all
// eight shards, merge-test-shards.ts dies on a missing-input error instead of
// reporting the test failures. The workflow's "Uploaded even when the shard
// fails" step is written against artifacts that exist on a red run.
//
// So every lane runs, in order, whatever the lanes before it did; the merge
// runs over whatever slices exist; and the exit code is the first failing
// lane's. Three details are load-bearing:
//
//   - Each lane's slice, and the staged file itself, are deleted before the
//     lanes run. Whether a file exists is the entire merge-input decision
//     below, so a slice an earlier local run left behind would otherwise be
//     merged in as this run's coverage.
//   - Zero slices is not an error here. It is what a shard whose slice held no
//     file from this workspace legitimately produces, and merge-test-shards.ts
//     already treats that as legitimate one level up. `mergeLcovFiles` throws
//     on an empty input set — correct for the shard merge, which knows how
//     many shards ran, and wrong here.
//   - The lanes run sequentially and are not detached. The watchdog above kills
//     by process group and has to reach them, and interleaving two lanes'
//     output would break the property that the log's last line names the file
//     that wedged.
//
// Usage: bun ./scripts/ci/run-workspace-coverage.ts --workspace=api

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT_DIR, WORKSPACES, type WorkspaceName } from '../lib/config';
import { runCommand } from '../lib/exec';
import { SHARDED_LCOV_PATHS, TEST_LANES } from '../lib/test-lanes';
import { mergeLcovFiles } from '../qa-gate/merge-lcov-shards';

/** One lane's coverage script and the LCOV slice it writes. */
export interface CoverageLane {
  readonly id: string;
  readonly coverageScript: string;
  /** Repo-relative slice the lane's `--coverage-dir` produces. */
  readonly lcovPath: string;
}

export interface LaneRun {
  readonly id: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface WorkspaceCoverageResult {
  /** The first failing lane's code, or 1 for a merge failure, else 0. */
  readonly exitCode: number;
  readonly lanes: readonly LaneRun[];
  /** Slices that existed after the lanes ran and went into the merge. */
  readonly mergedSlices: number;
}

export interface WorkspaceCoverageOptions {
  readonly lanes: readonly CoverageLane[];
  /** Directory the lane scripts run in — the workspace root. */
  readonly cwd: string;
  /** Repo-relative path of the merged per-workspace lcov.info. */
  readonly stagedLcovPath: string;
  /** Root the repo-relative paths above resolve against. */
  readonly rootDir?: string;
}

/**
 * The coverage lanes a workspace owns, in registry order. Every one needs its
 * own `lcovPath`: two lanes sharing a coverage directory would have the second
 * overwrite the first, and the merge would report one lane's coverage as the
 * whole workspace's.
 * // Usage: lanesForWorkspace('api');
 */
export const lanesForWorkspace = (workspace: WorkspaceName): readonly CoverageLane[] => {
  const lanes = TEST_LANES.filter((lane) => lane.workspace === workspace);
  if (lanes.length === 0) {
    throw new Error(`No test lanes are declared for workspace '${workspace}'.`);
  }
  return lanes.map((lane) => {
    if (!lane.lcovPath) {
      throw new Error(
        `Lane '${lane.id}' declares no lcovPath, so its coverage cannot be merged into a ` +
          'per-workspace file. Add one to TEST_LANES, or run the lane directly.'
      );
    }
    return { id: lane.id, coverageScript: lane.coverageScript, lcovPath: lane.lcovPath };
  });
};

const runLane = async (lane: CoverageLane, cwd: string): Promise<LaneRun> => {
  try {
    const { exitCode, duration } = await runCommand(lane.id, ['bun', 'run', lane.coverageScript], {
      cwd,
    });
    return { id: lane.id, exitCode, durationMs: duration };
  } catch (caught) {
    // `Bun.spawn` throws instead of resolving when the child cannot start. A
    // lane that never ran is a failed lane, not a crashed orchestrator: the
    // lanes after it still have to run and the merge still has to happen.
    const message = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`Lane '${lane.id}' could not start: ${message}\n`);
    return { id: lane.id, exitCode: 1, durationMs: 0 };
  }
};

/** Merge the slices that exist, returning how many there were. */
const mergeExistingSlices = async (
  stagedPath: string,
  slicePaths: readonly string[]
): Promise<number> => {
  const present: string[] = [];
  for (const path of slicePaths) {
    if (await Bun.file(path).exists()) present.push(path);
  }
  if (present.length === 0) return 0;
  await mergeLcovFiles(stagedPath, present);
  return present.length;
};

/**
 * Run a workspace's coverage lanes and merge their slices. Runs every lane
 * regardless of the ones before it, so a red run still produces the JUnit
 * reports and the merged LCOV the shard uploads.
 * // Usage: const { exitCode } = await runWorkspaceCoverage({ lanes: lanesForWorkspace('api'), cwd: WORKSPACES.api.path, stagedLcovPath: SHARDED_LCOV_PATHS.api });
 */
export const runWorkspaceCoverage = async (
  options: WorkspaceCoverageOptions
): Promise<WorkspaceCoverageResult> => {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const stagedPath = join(rootDir, options.stagedLcovPath);
  const slicePaths = options.lanes.map((lane) => join(rootDir, lane.lcovPath));

  await Promise.all([...slicePaths, stagedPath].map((path) => rm(path, { force: true })));

  const lanes: LaneRun[] = [];
  for (const lane of options.lanes) lanes.push(await runLane(lane, options.cwd));

  let mergedSlices = 0;
  let mergeFailed = false;
  try {
    mergedSlices = await mergeExistingSlices(stagedPath, slicePaths);
  } catch (caught) {
    mergeFailed = true;
    const message = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`Merging ${options.stagedLcovPath} failed: ${message}\n`);
  }

  // One line per lane, because the lanes stream into a shared job log: without
  // it a red run means scrolling back through both suites to find which one
  // owns the failure.
  for (const lane of lanes) {
    process.stderr.write(
      `  ${lane.id}: exit ${lane.exitCode} in ${(lane.durationMs / 1000).toFixed(1)}s\n`
    );
  }
  process.stderr.write(
    mergedSlices === 0
      ? `  no LCOV slice was produced; nothing merged into ${options.stagedLcovPath}\n`
      : `  merged ${mergedSlices} LCOV slice(s) into ${options.stagedLcovPath}\n`
  );

  // A lane failure outranks a merge failure: it is the more specific fact, and
  // the merge is downstream of it. A zero-slice run is not a failure at all, so
  // it must not mask a lane that did fail either.
  const failed = lanes.find((lane) => lane.exitCode !== 0);
  return { exitCode: failed?.exitCode ?? (mergeFailed ? 1 : 0), lanes, mergedSlices };
};

const USAGE = 'Usage: bun ./scripts/ci/run-workspace-coverage.ts --workspace=<name>\n';

if (import.meta.main) {
  const flags = process.argv.slice(2);
  const workspace = flags
    .find((flag) => flag.startsWith('--workspace='))
    ?.slice('--workspace='.length);
  const unknown = flags.some((flag) => !flag.startsWith('--workspace='));
  if (unknown || !workspace || !(workspace in WORKSPACES)) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const name = workspace as WorkspaceName;
  const stagedLcovPath = SHARDED_LCOV_PATHS[name];
  if (!stagedLcovPath) {
    process.stderr.write(`Workspace '${name}' has no staged LCOV path to merge into.\n`);
    process.exit(2);
  }

  const result = await runWorkspaceCoverage({
    lanes: lanesForWorkspace(name),
    cwd: WORKSPACES[name].path,
    stagedLcovPath,
  });
  process.exit(result.exitCode);
}
