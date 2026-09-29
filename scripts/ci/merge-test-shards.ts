#!/usr/bin/env bun
// Reassemble the artifacts a fanned-out Test run leaves behind, so the merge
// job can hand the QA collector the same shapes a single-machine run produced.
// The fan-out is the 8 numbered shards plus the unsharded frontend job, which
// uploads the same artifact shape under `test-shard-frontend`.
//
// Two kinds of state come back and each needs a different merge:
//
//   LCOV        per-workspace, and NOT concatenable — see
//               scripts/qa-gate/merge-lcov-shards.ts for why a plain union of
//               `DA:` lines reports a coverage regression that did not happen.
//               The frontend contributes exactly one file (its lane cannot be
//               sharded for that same reason), so its merge is a copy. Which
//               job directories owe a workspace a report comes from the lane
//               registry (`expectedLcovShards`): a missing, empty or truncated
//               one fails that workspace's merge naming the shard, and the
//               workspace is reported in `coverageErrors` so the QA fragment
//               marks its coverage unavailable with that reason.
//   run meta    exit codes and durations. The suite's exit code is non-zero if
//               any job's was, and its duration is the slowest job's, which is
//               the lane's wall clock now that they run concurrently.
//
// JUnit reports are not merged here: scripts/qa-gate/junit-results.ts reads
// them straight out of the shard directories, so nothing has to move.
//
// Usage: bun ./scripts/ci/merge-test-shards.ts <shards-dir> [shard-count] > shard-summary.json

import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { SHARDED_LCOV_PATHS, TEST_LANES } from '../lib/test-lanes';
import { type LcovShardInput, mergeLcovFiles } from '../qa-gate/merge-lcov-shards';
import { mergeUnhandledErrors, type UnhandledErrors } from '../qa-gate/unhandled-errors';

export interface ShardMeta {
  /** A shard number, or 'frontend' for the unsharded frontend job. */
  readonly shard: number | string;
  readonly exitCode: number;
  readonly durationSeconds: number;
  /** Watchdog attempts the job took; absent in receipts from before it was recorded. */
  readonly attempts?: number;
}

export interface ShardSummary {
  readonly shards: number;
  /** Non-zero if any shard failed. */
  readonly exitCode: number;
  /** Wall clock of the slowest shard, which is the lane's critical path. */
  readonly durationSeconds: number;
  readonly unhandledErrors: UnhandledErrors;
  /**
   * Workspaces whose LCOV could not be merged, each with the reason naming the
   * shard. Present only when non-empty; the QA fragment turns each into an
   * `unavailable` coverage measurement rather than a lower complete number.
   */
  readonly coverageErrors?: Readonly<Record<string, string>>;
}

// `readJson` casts whatever parsed, so a `shard-meta.json` that is valid JSON
// of the wrong shape reaches here with `exitCode: undefined`. Read naively,
// `find(meta => meta.exitCode !== 0)?.exitCode ?? 0` matches that shard *and*
// then folds it back to 0 — a green suite — while also shadowing any later
// shard's real failure. `durationSeconds` degrades to NaN the same way. Both
// are normalised here, mirroring the `isShardSummary` guard one step
// downstream in collect-test-metrics.ts.
const exitCodeOf = (meta: Partial<ShardMeta> | null): number =>
  Number.isFinite(meta?.exitCode) ? (meta as ShardMeta).exitCode : 1;

const durationOf = (meta: Partial<ShardMeta> | null): number =>
  Number.isFinite(meta?.durationSeconds) ? (meta as ShardMeta).durationSeconds : 0;

/** Fold per-shard run metadata into the single pair the QA fragment reports. */
export const summarizeShardMeta = (
  metas: readonly ShardMeta[]
): Pick<ShardSummary, 'exitCode' | 'durationSeconds'> => ({
  exitCode: metas.map(exitCodeOf).find((code) => code !== 0) ?? 0,
  durationSeconds: metas.reduce((max, meta) => Math.max(max, durationOf(meta)), 0),
});

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  try {
    return (await file.json()) as T;
  } catch {
    return fallback;
  }
};

// Each unsharded lane runs whole in its own CI job and uploads its own
// `test-shard-<id>` directory, so the expected directory count is derived here
// from the registry rather than restated as arithmetic in the workflow — a new
// `sharded: false` lane changes it without a YAML edit to forget.
const unshardedLanes = TEST_LANES.filter((lane) => !lane.sharded);
const unshardedJobCount = unshardedLanes.length;

const NUMBERED_SHARD = /^test-shard-\d+$/;

/** Every artifact directory name a run with `expectedJobs` jobs must have uploaded. */
const expectedJobNames = (expectedJobs: number): string[] => {
  const numbered = Math.max(expectedJobs - unshardedJobCount, 0);
  return [
    ...Array.from({ length: numbered }, (_, index) => `test-shard-${index + 1}`),
    ...unshardedLanes.map((lane) => `test-shard-${lane.id}`),
  ];
};

/**
 * The job directories that owe `workspace` an LCOV report. A workspace whose
 * lanes are sharded is owed one by every numbered shard; a workspace with an
 * unsharded lane is owed one by that lane's own job and by no numbered shard.
 * // Usage: expectedLcovShards('frontend', names) // ['test-shard-frontend']
 */
export const expectedLcovShards = (
  workspace: string,
  jobNames: readonly string[]
): readonly string[] => {
  const unsharded = unshardedLanes.filter((lane) => lane.workspace === workspace);
  if (unsharded.length > 0) return unsharded.map((lane) => `test-shard-${lane.id}`);
  return jobNames.filter((name) => NUMBERED_SHARD.test(name));
};

/** Shard artifact directories, sorted so blob file names stay stable across runs. */
export const listShardDirs = async (shardsRoot: string): Promise<readonly string[]> => {
  const entries = await readdir(shardsRoot, { withFileTypes: true });
  // The download pattern `test-shard-*` also matches `test-shard-<n>-log`.
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('-log'))
    .map((entry) => join(shardsRoot, entry.name))
    .sort();
};

/** The set of uploaded job directories is not the set the run should have produced. */
export class ShardSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShardSetError';
  }
}

/**
 * Reassemble one sharded run. `outputRoot` is the checkout the merged files
 * land in; it is a parameter only so tests can point it somewhere disposable
 * instead of overwriting the developer's own coverage output.
 * // Usage: await mergeTestShards('shards');
 */
export const mergeTestShards = async (
  shardsRoot: string,
  outputRoot: string = ROOT_DIR,
  expectedShards?: number
): Promise<ShardSummary> => {
  // Whatever an earlier run staged is not this run's coverage: drop it before
  // anything can fail, so a failed merge leaves no file for the collector to read.
  await Promise.all(
    Object.values(SHARDED_LCOV_PATHS).map((lcovPath) =>
      rm(join(outputRoot, lcovPath), { force: true })
    )
  );
  const shardDirs = await listShardDirs(shardsRoot);
  if (shardDirs.length === 0) {
    throw new Error(`No shard directories under ${shardsRoot}; nothing to merge.`);
  }
  // A shard job that dies before "Upload shard results" runs (runner OOM, a
  // cancelled/timed-out job) leaves its directory missing rather than empty,
  // so the empty-set check above does not catch it. The remaining shards can
  // still be green, and summarizeShardMeta would report a passing suite over
  // an incomplete file set.
  const presentNames = shardDirs.map((dir) => basename(dir));
  // The names must match, not only the count: a missing shard beside a stray
  // one is the same count and the same incomplete file set.
  const expectedNames = expectedShards === undefined ? null : expectedJobNames(expectedShards);
  if (expectedNames) {
    const missing = expectedNames.filter((name) => !presentNames.includes(name));
    const unexpected = presentNames.filter((name) => !expectedNames.includes(name));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new ShardSetError(
        `Expected ${expectedShards} test-job directories under ${shardsRoot} (the numbered shards ` +
          `plus one job per unsharded lane), found ${shardDirs.length}` +
          `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
          `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : ''}. ` +
          'A job likely failed before its upload step ran; merging a partial set would report ' +
          'incomplete coverage and test counts as a green run.'
      );
    }
  }

  const jobNames = expectedNames ?? presentNames;
  const coverageErrors: Record<string, string> = {};
  for (const [workspace, lcovPath] of Object.entries(SHARDED_LCOV_PATHS)) {
    const inputs: LcovShardInput[] = expectedLcovShards(workspace, jobNames).map((name) => ({
      shard: name,
      path: join(shardsRoot, name, lcovPath),
    }));
    try {
      await mergeLcovFiles(join(outputRoot, lcovPath), inputs);
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      coverageErrors[workspace] = `Merging ${workspace} coverage failed: ${reason}`;
    }
  }

  const metas = await Promise.all(
    shardDirs.map((dir) =>
      readJson<ShardMeta>(join(dir, 'shard-meta.json'), {
        shard: 0,
        exitCode: 1,
        durationSeconds: 0,
      })
    )
  );
  const unhandledErrors = mergeUnhandledErrors(
    await Promise.all(
      shardDirs.map((dir) =>
        readJson<UnhandledErrors>(join(dir, 'unhandled-errors.json'), {
          errors: 0,
          headlines: [],
        })
      )
    )
  );

  return {
    shards: shardDirs.length,
    ...summarizeShardMeta(metas),
    unhandledErrors,
    ...(Object.keys(coverageErrors).length > 0 ? { coverageErrors } : {}),
  };
};

/** What the merge job hands the collector when the uploaded job set itself is wrong. */
const incompleteSetSummary = (reason: string): ShardSummary => ({
  shards: 0,
  exitCode: 1,
  durationSeconds: 0,
  unhandledErrors: { errors: 0, headlines: [] },
  coverageErrors: Object.fromEntries(
    Object.keys(SHARDED_LCOV_PATHS).map((workspace) => [workspace, reason])
  ),
});

if (import.meta.main) {
  const [, , shardsRoot, shardCountArg] = process.argv;
  if (!shardsRoot) {
    process.stderr.write(
      'Usage: bun ./scripts/ci/merge-test-shards.ts <shards-dir> [shard-count] > shard-summary.json\n'
    );
    process.exit(1);
  }
  let summary: ShardSummary;
  try {
    summary = await mergeTestShards(
      shardsRoot,
      ROOT_DIR,
      shardCountArg ? Number(shardCountArg) + unshardedJobCount : undefined
    );
  } catch (caught) {
    if (!(caught instanceof ShardSetError)) throw caught;
    // Still emit a summary so the collector can say why coverage is unavailable.
    process.stdout.write(`${JSON.stringify(incompleteSetSummary(caught.message), null, 2)}\n`);
    throw caught;
  }
  process.stderr.write(
    `Merged ${summary.shards} shard(s): exit ${summary.exitCode}, slowest ${summary.durationSeconds}s\n`
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  for (const [workspace, reason] of Object.entries(summary.coverageErrors ?? {})) {
    process.stderr.write(`::error title=Coverage merge failed (${workspace})::${reason}\n`);
  }
  if (summary.coverageErrors) process.exit(1);
}
