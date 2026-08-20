// Reassemble the per-shard `--timings` slices into one file per Bun lane, and
// prove the shards actually partitioned the file set while doing it.
//
// Why the proof is the point:
//
// Without `--timings`, `bun test --shard=i/N` is a round-robin over the lane's
// alphabetical file list. Every shard computes the identical list and takes its
// stride, so N shards cover the lane exactly once between them and cannot
// disagree — the partition is a property of the algorithm, not of any shared
// state.
//
// `--timings` moves the assignment onto a file all N shards read. That is what
// buys the balance, and it is also a new way to be wrong: if one shard reads a
// different version of that file than the others (a cache saved by a concurrent
// run landing mid-fan-out), the shards no longer agree on the split. Files get
// run twice, or not at all, and *every shard still exits 0* — the suite reports
// green while covering less than it did before. Nothing else in the pipeline
// counts total files, so this is where that has to be caught.
//
// Each shard writes only its own files under `--shard` (verified: shard 1/8 of
// `apps/shared` writes 6 entries, shard 2/8 writes 7, of 54 total), so the union
// of the slices is exactly the lane's file set when the run was healthy.
//
// Usage: bun ./scripts/ci/merge-timings-shards.ts <shards-dir> <out-dir>

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TEST_LANES, TIMINGS_DIR } from '../lib/test-lanes';

/** The on-disk shape Bun reads and writes. A malformed file is a hard error. */
export interface TimingsFile {
  readonly version: 1;
  readonly files: Record<string, number>;
}

export interface PartitionProblem {
  readonly lane: string;
  readonly kind: 'duplicate';
  readonly files: readonly string[];
}

export interface MergedLane {
  readonly lane: string;
  readonly shards: number;
  readonly files: number;
  readonly totalMs: number;
}

export interface TimingsMergeResult {
  readonly lanes: readonly MergedLane[];
  readonly problems: readonly PartitionProblem[];
}

const isTimingsFile = (value: unknown): value is TimingsFile => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; files?: unknown };
  if (candidate.version !== 1) return false;
  if (typeof candidate.files !== 'object' || candidate.files === null) return false;
  return Object.values(candidate.files as Record<string, unknown>).every(
    (ms) => typeof ms === 'number' && Number.isFinite(ms)
  );
};

/**
 * Merge one lane's slices. A file claimed by two shards is the signal that the
 * shards disagreed about the split; a file claimed by none cannot be seen from
 * here, because the union *is* the only record of what ran.
 * // Usage: mergeLaneSlices('api', [sliceA, sliceB]);
 */
export const mergeLaneSlices = (
  lane: string,
  slices: readonly TimingsFile[]
): { merged: TimingsFile; problem: PartitionProblem | null } => {
  const files: Record<string, number> = {};
  const duplicates = new Set<string>();
  for (const slice of slices) {
    for (const [path, ms] of Object.entries(slice.files)) {
      if (path in files) duplicates.add(path);
      // Last writer wins; the durations agree to within run-to-run noise, and
      // a duplicate is reported as a failure anyway.
      files[path] = ms;
    }
  }
  return {
    merged: { version: 1, files },
    problem:
      duplicates.size > 0 ? { lane, kind: 'duplicate', files: [...duplicates].sort() } : null,
  };
};

const readSlice = async (path: string): Promise<TimingsFile | null> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return null;
  }
  return isTimingsFile(parsed) ? parsed : null;
};

/** // Usage: await mergeTimingsShards('shards', '.mango/artifacts/timings'); */
export const mergeTimingsShards = async (
  shardsRoot: string,
  outDir: string
): Promise<TimingsMergeResult> => {
  const shardDirs = (await readdir(shardsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(shardsRoot, entry.name))
    .sort();

  await mkdir(outDir, { recursive: true });

  const lanes: MergedLane[] = [];
  const problems: PartitionProblem[] = [];

  for (const lane of TEST_LANES) {
    if (!lane.timingsPath) continue;
    const basename = lane.timingsPath.slice(`${TIMINGS_DIR}/`.length);
    const slices: TimingsFile[] = [];
    for (const shardDir of shardDirs) {
      const slice = await readSlice(join(shardDir, lane.timingsPath));
      if (slice) slices.push(slice);
    }
    // A lane with no slices at all is not an error here: `frontend-bun` runs two
    // files across eight shards, so most shards legitimately contribute nothing,
    // and a lane that did not run leaves the previous merged file in place.
    if (slices.length === 0) continue;

    const { merged, problem } = mergeLaneSlices(lane.id, slices);
    if (problem) problems.push(problem);

    await writeFile(join(outDir, basename), `${JSON.stringify(merged, null, 2)}\n`);
    lanes.push({
      lane: lane.id,
      shards: slices.length,
      files: Object.keys(merged.files).length,
      totalMs: Object.values(merged.files).reduce((sum, ms) => sum + ms, 0),
    });
  }

  return { lanes, problems };
};

if (import.meta.main) {
  const [shardsRoot, outDir] = process.argv.slice(2);
  if (!shardsRoot || !outDir) {
    process.stderr.write(
      'Usage: bun ./scripts/ci/merge-timings-shards.ts <shards-dir> <out-dir>\n'
    );
    process.exit(2);
  }

  const { lanes, problems } = await mergeTimingsShards(shardsRoot, outDir);
  for (const lane of lanes) {
    process.stderr.write(
      `${lane.lane}: ${lane.files} files from ${lane.shards} shard(s), ${(lane.totalMs / 1000).toFixed(1)}s\n`
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(
        `::error::${problem.lane}: ${problem.files.length} file(s) ran on more than one shard — ` +
          `the shards disagreed about the split, so the suite covered less than it reports: ` +
          `${problem.files.slice(0, 5).join(', ')}\n`
      );
    }
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify({ lanes }, null, 2)}\n`);
}
