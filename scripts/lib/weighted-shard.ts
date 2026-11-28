// Turns a lane command that carries Bun's `--shard=i/N` into one that names the
// files of shard `i` by tracked weight. The CI coverage shards of a weighted lane
// go through it (scripts/run-weighted-shard.ts), so the shard split balances the
// way the local worker split does and is still a function of the commit alone:
// the file set and `LANE_WEIGHTS`, both committed. No timings snapshot is read,
// so a retried shard computes the partition its first attempt did.

import { parseShard } from './test';
import { laneCensus, partitionByWeight, type WorkerLaneSpec } from './test-workers';

/** What the split reads from a lane; `weights` absent means the lane stays on Bun's `--shard`. */
export type WeightedShardLane = Pick<
  WorkerLaneSpec,
  'id' | 'cwd' | 'testDir' | 'alsoRuns' | 'weights'
>;

export interface WeightedShard {
  /** The command to run: the input with `--shard` and the test directory replaced by files. */
  readonly command: readonly string[];
  /** `[index, count]` of the shard, or null when the command carried none. */
  readonly shard: readonly [number, number] | null;
  /** The files this shard runs, lane-relative; null when the command is left as it was. */
  readonly files: readonly string[] | null;
}

/**
 * Rewrites `command` for one shard. A command without `--shard` runs the whole
 * lane as it was, and so does a lane without tracked weights. Otherwise the
 * `--shard` argument and the trailing test directory give way to the shard's
 * files as `./path` arguments, which Bun reads as paths and not as substring
 * filters. `--shard` must not survive next to explicit files: Bun would shard
 * the subset again and the other half of it would run nowhere.
 *
 * @example
 * weightedShard(lane, ['bun', 'test', '--shard=2/2', 'tests/integration']).files?.length; // => 84
 */
export function weightedShard(
  lane: WeightedShardLane,
  command: readonly string[],
  census: readonly string[] = laneCensus(lane)
): WeightedShard {
  const shardArgs = command.filter((arg) => arg === '--shard' || arg.startsWith('--shard='));
  const [shardArg] = shardArgs;
  if (shardArg === undefined) return { command, shard: null, files: null };
  if (shardArgs.length > 1 || shardArg === '--shard') {
    throw new Error(
      `weighted shard (${lane.id}): expected one --shard=<index>/<count> argument | received: ${JSON.stringify(shardArgs)}`
    );
  }
  if (!lane.weights) return { command, shard: null, files: null };

  const { index, count } = parseShard(shardArg);
  if (command.at(-1) !== lane.testDir) {
    throw new Error(
      `weighted shard (${lane.id}): expected the command to end with ${lane.testDir} | received: ${JSON.stringify(command.at(-1))}`
    );
  }
  const files = partitionByWeight(census, lane.weights, count)[index - 1] ?? [];
  if (files.length === 0) {
    // A command with no file argument would run every test file under the working directory.
    throw new Error(
      `weighted shard (${lane.id}): expected at least one file per shard | received: ${census.length} files for shard ${index}/${count}`
    );
  }
  return {
    command: [
      ...command.filter((arg) => arg !== shardArg).slice(0, -1),
      ...files.map((file) => `./${file}`),
    ],
    shard: [index, count],
    files,
  };
}
