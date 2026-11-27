#!/usr/bin/env bun
// Runs a lane's `bun test` command for one CI shard, splitting the lane by its
// tracked file weights instead of Bun's round-robin `--shard=i/N`. The api
// workspace's `test:coverage:integration` script is the caller:
//
//   bun ../../scripts/run-weighted-shard.ts --lane=api-integration -- bun ../../scripts/with-test-home.ts bun test --coverage ... $MANGOSTUDIO_BUN_TEST_ARGS tests/integration
//
// The shell has already expanded `$MANGOSTUDIO_BUN_TEST_ARGS` by the time this
// runs: it is `--shard=i/N` in a shard and nothing in a whole-lane run. See
// scripts/lib/weighted-shard.ts for the rewrite. A bad shard argument fails the
// step; it never falls back to running the lane whole or by Bun's split.
//
// Exit code: the command's, or 128 plus the signal that ended it.

import { constants } from 'node:os';

import { error, info } from './lib/log';
import { laneById, type TestLaneId } from './lib/test-lanes';
import { DEFAULT_FILE_WEIGHT, laneSpec } from './lib/test-workers';
import { weightedShard } from './lib/weighted-shard';

const USAGE = 'run-weighted-shard: expected --lane=<id> -- <bun test command> | received: ';

/** Starts the command and resolves with the exit code to report. */
async function run(command: readonly string[], cwd: string): Promise<number> {
  const [program, ...args] = command;
  if (!program) throw new Error(`${USAGE}an empty command`);
  const child = Bun.spawn({
    cmd: [program, ...args],
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  // The child is in this process's group, so a group signal reaches it too; this
  // covers a signal sent to this pid alone.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  const exitCode = await child.exited;
  if (child.signalCode) {
    return 128 + (constants.signals[child.signalCode as keyof typeof constants.signals] ?? 0);
  }
  return exitCode;
}

async function main(argv: readonly string[]): Promise<number> {
  const separator = argv.indexOf('--');
  const laneId = argv
    .slice(0, separator === -1 ? undefined : separator)
    .find((arg) => arg.startsWith('--lane='));
  if (!laneId || separator === -1) throw new Error(`${USAGE}${JSON.stringify(argv.join(' '))}`);

  const command = argv.slice(separator + 1);
  const spec = laneSpec(laneById(laneId.slice('--lane='.length) as TestLaneId), command);
  const planned = weightedShard(spec, command);
  if (planned.shard && planned.files) {
    const weights = spec.weights ?? {};
    const weight = planned.files.reduce(
      (sum, file) => sum + (weights[file] ?? DEFAULT_FILE_WEIGHT),
      0
    );
    info(
      `${spec.id}: shard ${planned.shard[0]}/${planned.shard[1]} runs ${planned.files.length} files by tracked weight (${weight})`
    );
  }
  return run(planned.command, spec.cwd);
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
