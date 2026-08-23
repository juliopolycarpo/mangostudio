import { WORKSPACES, type WorkspaceName } from './config';
import { TEST_LANES } from './test-lanes';

export type TestLaneTask = 'test:unit' | 'test:integration' | 'test:coverage';

/** `--shard=<index>/<count>`, already validated. */
export interface TestShard {
  readonly index: number;
  readonly count: number;
}

/** Build a filtered Turbo test-lane command. // Usage: createTurboTestCommand('test:unit', ['api']); */
export function createTurboTestCommand(task: TestLaneTask, workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', task, '--ui=stream', ...filters];
}

/**
 * The workspaces whose coverage lanes a `--shard=i/N` run may split. The
 * frontend is not one of them: Bun's LCOV is not union-mergeable across
 * shards, so its lane runs whole, in its own CI job (see `sharded` in
 * test-lanes.ts).
 * // Usage: createTurboTestCommand('test:coverage', shardedCoverageWorkspaces());
 */
export function shardedCoverageWorkspaces(): WorkspaceName[] {
  return TEST_LANES.filter((lane) => lane.sharded && lane.workspace !== 'root').map(
    (lane) => lane.workspace as WorkspaceName
  );
}

/**
 * Parse `--shard=i/N`. Both halves must be positive integers and `i` must be in
 * range: a typo that silently ran shard 1 of 1 would report a green suite from
 * a fraction of the files, which is the failure this validation exists to stop.
 * // Usage: parseShard('--shard=2/8');
 */
export function parseShard(arg: string): TestShard {
  const value = arg.slice('--shard='.length);
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(`Invalid --shard value: '${value}'. Expected <index>/<count>, e.g. 2/8.`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1) throw new Error(`Invalid --shard count: ${count}. Must be at least 1.`);
  if (index < 1 || index > count) {
    throw new Error(`Invalid --shard index: ${index}. Must be between 1 and ${count}.`);
  }
  return { index, count };
}

/**
 * The environment the lane scripts read. `MANGOSTUDIO_BUN_TEST_ARGS` carries
 * the shard flag for every sharded lane; unsharded lanes (the frontend) do not
 * reference the variable at all, which `scripts/tests/test-lanes.unit.test.ts`
 * pins — a lane that both shards and writes whole-run coverage would merge
 * partial LCOV as if it were complete.
 *
 * Turbo's `MANGOSTUDIO_*` allowlist on the test tasks puts it in the cache
 * key, so a run at a different shard is a different run.
 * // Usage: runCommand(label, cmd, { env: testLaneEnv(shard) });
 */
export function testLaneEnv(shard: TestShard | null): Record<string, string> {
  if (!shard) return { MANGOSTUDIO_BUN_TEST_ARGS: '' };
  return { MANGOSTUDIO_BUN_TEST_ARGS: `--shard=${shard.index}/${shard.count}` };
}
