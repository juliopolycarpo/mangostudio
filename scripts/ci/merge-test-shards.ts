#!/usr/bin/env bun
// Reassemble the artifacts a sharded Test run leaves behind, so the merge job
// can hand the QA collector the same shapes an unsharded run produced.
//
// Three kinds of state come back from the shards and each needs a different
// merge:
//
//   LCOV        per-workspace, and NOT concatenable — see
//               scripts/qa-gate/merge-lcov-shards.ts for why a plain union of
//               `DA:` lines reports a coverage regression that did not happen.
//   Vitest blob just staged into place; `vitest --mergeReports` does the real
//               work, and it reproduces the unsharded numbers exactly.
//   run meta    exit codes and durations. The suite's exit code is non-zero if
//               any shard's was, and its duration is the slowest shard's, which
//               is the lane's wall clock now that they run concurrently.
//
// JUnit reports are not merged here: scripts/qa-gate/junit-results.ts reads
// them straight out of the shard directories, so nothing has to move.
//
// Usage: bun ./scripts/ci/merge-test-shards.ts <shards-dir> > shard-summary.json

import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { SHARDED_LCOV_PATHS, VITEST_BLOB_DIR } from '../lib/test-lanes';
import { mergeLcovFiles } from '../qa-gate/merge-lcov-shards';
import { mergeUnhandledErrors, type UnhandledErrors } from '../qa-gate/unhandled-errors';

export interface ShardMeta {
  readonly shard: number;
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

/** Fold per-shard run metadata into the single pair the QA fragment reports. */
export const summarizeShardMeta = (
  metas: readonly ShardMeta[]
): Pick<ShardSummary, 'exitCode' | 'durationSeconds'> => ({
  exitCode: metas.find((meta) => meta.exitCode !== 0)?.exitCode ?? 0,
  durationSeconds: metas.reduce((max, meta) => Math.max(max, meta.durationSeconds), 0),
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
  outputRoot: string = ROOT_DIR
): Promise<ShardSummary> => {
  const shardDirs = await listShardDirs(shardsRoot);
  if (shardDirs.length === 0) {
    throw new Error(`No shard directories under ${shardsRoot}; nothing to merge.`);
  }

  for (const [workspace, lcovPath] of Object.entries(SHARDED_LCOV_PATHS)) {
    const inputs = shardDirs.map((dir) => join(dir, lcovPath));
    await mergeLcovFiles(join(outputRoot, lcovPath), inputs).catch((caught: unknown) => {
      throw new Error(
        `Merging ${workspace} coverage failed: ${caught instanceof Error ? caught.message : String(caught)}`
      );
    });
  }

  // Copy whatever blob each shard produced rather than reconstructing its name
  // from the directory order: `test-shard-10` sorts before `test-shard-2`, so
  // an index-derived name would pair the wrong file with the wrong shard at ten
  // or more. Names are reassigned sequentially here; `--mergeReports` reads the
  // directory, not the file names.
  // Cleared first: a blob left behind by an earlier run in this checkout would
  // be replayed by `--mergeReports` and land in the coverage the threshold gate
  // reads. `.vitest-reports` is gitignored, so a local re-run is exactly where
  // that stale file survives.
  const blobDir = join(outputRoot, VITEST_BLOB_DIR);
  await rm(blobDir, { recursive: true, force: true });
  await mkdir(blobDir, { recursive: true });
  let blobs = 0;
  for (const dir of shardDirs) {
    const sourceDir = join(dir, VITEST_BLOB_DIR);
    const names = await readdir(sourceDir).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
      blobs++;
      await Bun.write(join(blobDir, `blob-${blobs}.json`), Bun.file(join(sourceDir, name)));
    }
  }
  if (blobs === 0) {
    throw new Error(
      `No Vitest blob reports under ${shardsRoot}/*/${VITEST_BLOB_DIR}; the frontend lane ` +
        'produced no coverage to merge. If the shards themselves were green, check that the ' +
        'upload step sets include-hidden-files: true — .vitest-reports is a dot-directory, and ' +
        'the default drops it from the artifact without failing the upload.'
    );
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
  const [, , shardsRoot] = process.argv;
  if (!shardsRoot) {
    process.stderr.write(
      'Usage: bun ./scripts/ci/merge-test-shards.ts <shards-dir> > shard-summary.json\n'
    );
    process.exit(1);
  }
  const summary = await mergeTestShards(shardsRoot);
  process.stderr.write(
    `Merged ${summary.shards} shard(s): exit ${summary.exitCode}, slowest ${summary.durationSeconds}s\n`
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
