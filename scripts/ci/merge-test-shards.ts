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
//               sharded for that same reason), so its merge is a copy.
//   run meta    exit codes and durations. The suite's exit code is non-zero if
//               any job's was, and its duration is the slowest job's, which is
//               the lane's wall clock now that they run concurrently.
//
// JUnit reports are not merged here: scripts/qa-gate/junit-results.ts reads
// them straight out of the shard directories, so nothing has to move.
//
// Usage: bun ./scripts/ci/merge-test-shards.ts <shards-dir> [expected-shard-count] > shard-summary.json

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { SHARDED_LCOV_PATHS } from '../lib/test-lanes';
import { mergeLcovFiles } from '../qa-gate/merge-lcov-shards';
import { mergeUnhandledErrors, type UnhandledErrors } from '../qa-gate/unhandled-errors';

export interface ShardMeta {
  /** A shard number, or 'frontend' for the unsharded frontend job. */
  readonly shard: number | string;
  readonly exitCode: number;
  readonly durationSeconds: number;
}

export interface ShardSummary {
  readonly shards: number;
  /** Non-zero if any shard failed. */
  readonly exitCode: number;
  /** Wall clock of the slowest shard, which is the lane's critical path. */
  readonly durationSeconds: number;
  readonly unhandledErrors: UnhandledErrors;
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

/** Shard artifact directories, sorted so blob file names stay stable across runs. */
export const listShardDirs = async (shardsRoot: string): Promise<readonly string[]> => {
  const entries = await readdir(shardsRoot, { withFileTypes: true });
  // The download pattern `test-shard-*` also matches `test-shard-<n>-log`.
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('-log'))
    .map((entry) => join(shardsRoot, entry.name))
    .sort();
};

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
  const shardDirs = await listShardDirs(shardsRoot);
  if (shardDirs.length === 0) {
    throw new Error(`No shard directories under ${shardsRoot}; nothing to merge.`);
  }
  // A shard job that dies before "Upload shard results" runs (runner OOM, a
  // cancelled/timed-out job) leaves its directory missing rather than empty,
  // so the empty-set check above does not catch it. The remaining shards can
  // still be green, and summarizeShardMeta would report a passing suite over
  // an incomplete file set.
  if (expectedShards !== undefined && shardDirs.length !== expectedShards) {
    throw new Error(
      `Expected ${expectedShards} test-job directories under ${shardsRoot} (the shards plus the ` +
        `frontend job), found ${shardDirs.length}. A job likely failed before its upload step ran; ` +
        'merging a partial set would report incomplete coverage and test counts as a green run.'
    );
  }

  for (const [workspace, lcovPath] of Object.entries(SHARDED_LCOV_PATHS)) {
    const inputs = shardDirs.map((dir) => join(dir, lcovPath));
    await mergeLcovFiles(join(outputRoot, lcovPath), inputs).catch((caught: unknown) => {
      throw new Error(
        `Merging ${workspace} coverage failed: ${caught instanceof Error ? caught.message : String(caught)}`
      );
    });
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

  return { shards: shardDirs.length, ...summarizeShardMeta(metas), unhandledErrors };
};

if (import.meta.main) {
  const [, , shardsRoot, expectedShardsArg] = process.argv;
  if (!shardsRoot) {
    process.stderr.write(
      'Usage: bun ./scripts/ci/merge-test-shards.ts <shards-dir> [expected-shard-count] > shard-summary.json\n'
    );
    process.exit(1);
  }
  const summary = await mergeTestShards(
    shardsRoot,
    ROOT_DIR,
    expectedShardsArg ? Number(expectedShardsArg) : undefined
  );
  process.stderr.write(
    `Merged ${summary.shards} shard(s): exit ${summary.exitCode}, slowest ${summary.durationSeconds}s\n`
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
