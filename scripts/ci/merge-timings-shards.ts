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
// `apps/shared` writes 6 entries, shard 2/8 writes 7, of 54 total) — but only
// if it runs that lane at all. A shard whose turbo invocation aborts on an
// earlier lane's failure (fail-fast, no `--continue`) never touches the
// `--timings` file it restored, so what lands on disk is the *previous* run's
// full baseline, not this shard's slice — and looks exactly like a legitimate
// one until it collides with whichever shard actually owns those files.
// (Measured: PR #903's own CI, shard 4/8 restored a 398-entry `api` baseline
// unchanged after `runtime` failed first in the same job, and would have
// duplicate-claimed 370 files against the shards that actually ran them.)
//
// A lane's JUnit report is the tell, but not because "a lane that ran always
// writes one" — measured on Bun 1.4.0, a shard whose slice of a lane is *empty*
// runs zero files, writes no JUnit report, and exits 0. What makes the rule
// safe is that the same empty run also rewrites its `--timings` file to
// `{"version":1,"files":{}}`, so the two cases a missing report covers are:
//
//   lane ran, empty slice  -> nothing to contribute; discarding costs nothing.
//   lane never ran         -> the restored full baseline is still on disk, and
//                             discarding it is the whole point.
//
// Both are discarded rather than merged as a claim. Do not weaken the JUnit
// check on the assumption that an empty run leaves a distinguishable file.
//
// Usage: bun ./scripts/ci/merge-timings-shards.ts <shards-dir> <out-dir>

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TEST_LANES, TIMINGS_DIR } from '../lib/test-lanes';
import { listShardDirs } from './merge-test-shards';

/** The on-disk shape Bun reads and writes. A malformed file is a hard error. */
export interface TimingsFile {
  readonly version: 1;
  readonly files: Record<string, number>;
}

export interface PartitionProblem {
  readonly lane: string;
  readonly kind: 'duplicate' | 'malformed';
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
  if (
    typeof candidate.files !== 'object' ||
    candidate.files === null ||
    Array.isArray(candidate.files)
  ) {
    return false;
  }
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

type SliceRead =
  | { readonly status: 'missing' }
  | { readonly status: 'malformed' }
  | { readonly status: 'ok'; readonly data: TimingsFile };

// Missing is the ordinary case for a shard that legitimately contributed
// nothing to this lane. Malformed — a truncated write from a run that landed
// mid-fan-out, or a shape `--timings` never produces — is not: it is
// indistinguishable from "missing" to the union below unless kept separate,
// which turns a corrupt shard into a silently smaller partition instead of
// the hard error the `TimingsFile` contract promises.
//
// A third case looks like "ok" but is not: a shard whose lane never ran at
// all (an earlier lane in the same turbo invocation failed and turbo stopped
// scheduling the rest) never touches its restored `--timings` file, so the
// untouched cache-restored baseline — every file the *previous* run's shards
// covered between them — sits on disk exactly as if this shard had covered
// it too. Nothing distinguishes that file from a genuine full-coverage
// contribution except that this shard's JUnit report for the same lane is
// missing. A lane that ran over zero files also writes no report, but it
// rewrites its timings file to an empty map first, so discarding that one
// too costs nothing — see the header for why the rule is safe.
const readSlice = async (junitPath: string, timingsPath: string): Promise<SliceRead> => {
  const file = Bun.file(timingsPath);
  if (!(await file.exists())) return { status: 'missing' };
  if (!(await Bun.file(junitPath).exists())) return { status: 'missing' };
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return { status: 'malformed' };
  }
  return isTimingsFile(parsed) ? { status: 'ok', data: parsed } : { status: 'malformed' };
};

/** // Usage: await mergeTimingsShards('shards', '.mango/artifacts/timings'); */
export const mergeTimingsShards = async (
  shardsRoot: string,
  outDir: string
): Promise<TimingsMergeResult> => {
  // Shared with the coverage merge rather than re-derived: the merge job's
  // `pattern: test-shard-*` download also matches the `test-shard-<n>-log`
  // failure artifacts, and a second copy of that rule is a second thing to
  // forget.
  const shardDirs = await listShardDirs(shardsRoot);

  await mkdir(outDir, { recursive: true });

  const lanes: MergedLane[] = [];
  const problems: PartitionProblem[] = [];

  for (const lane of TEST_LANES) {
    if (!lane.timingsPath) continue;
    const basename = lane.timingsPath.slice(`${TIMINGS_DIR}/`.length);
    const slices: TimingsFile[] = [];
    const malformed: string[] = [];
    for (const shardDir of shardDirs) {
      const result = await readSlice(
        join(shardDir, lane.junitPath),
        join(shardDir, lane.timingsPath)
      );
      if (result.status === 'ok') slices.push(result.data);
      else if (result.status === 'malformed') malformed.push(join(shardDir, lane.timingsPath));
    }
    if (malformed.length > 0) {
      problems.push({ lane: lane.id, kind: 'malformed', files: malformed.sort() });
    }
    // A lane with no slices at all is not an error here: a lane whose files all
    // landed on other jobs legitimately contributes nothing. The lane is simply
    // left out of `outDir`, which means it drops out of the saved cache and next
    // run's split for it falls back to round-robin — degraded balance, never a
    // wrong partition. The unsharded frontend lane rides the same path: its own
    // job contributes the one whole slice and every shard contributes none.
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
      const message =
        problem.kind === 'duplicate'
          ? `${problem.files.length} file(s) ran on more than one shard — ` +
            `the shards disagreed about the split, so the suite covered less than it reports`
          : `${problem.files.length} shard timings file(s) were malformed and dropped from the ` +
            `merge — the remaining shards are treated as the whole lane, so the suite covered ` +
            `less than it reports`;
      process.stderr.write(
        `::error::${problem.lane}: ${message}: ${problem.files.slice(0, 5).join(', ')}\n`
      );
    }
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify({ lanes }, null, 2)}\n`);
}
