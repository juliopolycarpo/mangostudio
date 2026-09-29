// The set of CI test jobs a complete run must deliver, derived from the lane
// registry rather than from whatever directories happen to exist. Listing the
// directories found would make a job that died before its upload step invisible:
// the remaining shards still add up to a plausible, smaller total.
//
// Sharded lanes run in every numbered shard (`test-shard-1..N`); an unsharded
// lane runs whole in its own job (`test-shard-<lane id>`).

import { join } from 'node:path';

import { TEST_LANES, type TestLane } from '../../lib/test-lanes';

/** One test job and the lanes it is expected to have run. */
export interface ExpectedJob {
  /** Human name used in reasons: `shard 3`, `frontend`, `local`. */
  readonly id: string;
  /** Directory the job's artifacts land in. */
  readonly dir: string;
  readonly lanes: readonly TestLane[];
}

export interface ExpectedJobSet {
  readonly jobs: readonly ExpectedJob[];
  /** Set when the expected set could not be established; every sharded lane is then unverified. */
  readonly unverified: string | null;
}

const NUMBERED_SHARD_DIR_RE = /^test-shard-(\d+)$/;

const shardDirName = (shard: number | string): string => `test-shard-${shard}`;

/**
 * Jobs of a CI run: `shardCount` numbered shards carrying every sharded lane,
 * plus one job per unsharded lane. A null count (the caller did not say how
 * many shards ran) falls back to the numbered directories found and marks the
 * set `unverified`, because a missing tail shard then cannot be seen.
 * // Usage: expectedShardJobs('shards', 8).jobs.map((job) => job.id)
 */
export const expectedShardJobs = (
  shardsRoot: string,
  shardCount: number | null,
  presentDirNames: readonly string[] = [],
  lanes: readonly TestLane[] = TEST_LANES
): ExpectedJobSet => {
  const shardedLanes = lanes.filter((lane) => lane.sharded);
  const numbers =
    shardCount === null
      ? presentDirNames
          .map((name) => NUMBERED_SHARD_DIR_RE.exec(name)?.[1])
          .filter((digits): digits is string => digits !== undefined)
          .map(Number)
          .sort((left, right) => left - right)
      : Array.from({ length: shardCount }, (_, index) => index + 1);

  const numbered: ExpectedJob[] =
    shardedLanes.length === 0
      ? []
      : numbers.map((shard) => ({
          id: `shard ${shard}`,
          dir: join(shardsRoot, shardDirName(shard)),
          lanes: shardedLanes,
        }));
  const whole: ExpectedJob[] = lanes
    .filter((lane) => !lane.sharded)
    .map((lane) => ({
      id: lane.id,
      dir: join(shardsRoot, shardDirName(lane.id)),
      lanes: [lane],
    }));

  return {
    jobs: [...numbered, ...whole],
    unverified:
      shardCount === null
        ? 'expected shard count was not provided; a lost trailing shard cannot be detected'
        : null,
  };
};

/**
 * A single-machine run: one job in `dir` carrying every lane.
 * // Usage: expectedLocalJobs('.').jobs[0]?.lanes.length
 */
export const expectedLocalJobs = (
  dir: string,
  lanes: readonly TestLane[] = TEST_LANES
): ExpectedJobSet => ({ jobs: [{ id: 'local', dir, lanes }], unverified: null });
