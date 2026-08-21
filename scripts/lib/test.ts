import { WORKSPACES, type WorkspaceName } from './config';
import { laneById } from './test-lanes';

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
 * The console reporters `vitest.config.ts` would have chosen for this run.
 *
 * A CLI `--reporter` *replaces* the config's `reporters` array rather than
 * adding to it (measured), so passing a file reporter alone silently drops
 * every console one. Both matter: without `default` the run prints nothing and
 * the `Errors N errors` / `This error originated in "…"` lines are never
 * emitted — the sole source `scripts/qa-gate/unhandled-errors.ts` has for
 * Vitest, because its JUnit reporter hardcodes `errors="0"` — and without
 * `github-actions` a failing test loses its inline annotation on the CI run.
 * The `GITHUB_ACTIONS` test mirrors the config's own; Turbo passes that
 * variable through to the lane tasks (measured).
 * // Usage: `${consoleReporters()} --reporter=junit --outputFile=…`
 */
const consoleReporters = (): string =>
  process.env.GITHUB_ACTIONS === 'true'
    ? '--reporter=default --reporter=github-actions'
    : '--reporter=default';

/**
 * The environment the lane scripts read. `MANGOSTUDIO_BUN_TEST_ARGS` carries
 * the shard flag for every Bun lane; `MANGOSTUDIO_VITEST_ARGS` carries the
 * frontend Vitest lane's whole reporter configuration, because its two modes
 * differ structurally rather than by one flag:
 *
 * - unsharded, it writes JUnit directly, and its coverage thresholds apply to
 *   the run that just happened;
 * - sharded, it writes a blob report instead, because a shard covers a fraction
 *   of the sources and would fail those same thresholds every time. The merge
 *   step replays the blobs, which is where coverage and thresholds are decided.
 *   Measured: four shards merged reproduce the unsharded run's coverage exactly
 *   (76.08 / 68.06 / 72.81 / 78.76 statements/branches/functions/lines).
 *
 * Both modes lead with `consoleReporters()` — see there for why the file
 * reporter cannot be passed on its own.
 *
 * Turbo's `MANGOSTUDIO_*` allowlist on the test tasks puts both in the cache
 * key, so a run at a different shard is a different run.
 * // Usage: runCommand(label, cmd, { env: testLaneEnv(shard) });
 */
export function testLaneEnv(shard: TestShard | null): Record<string, string> {
  const vitestLane = laneById('frontend-vitest');
  if (!shard) {
    return {
      MANGOSTUDIO_TEST_SHARD: '',
      MANGOSTUDIO_BUN_TEST_ARGS: '',
      MANGOSTUDIO_VITEST_ARGS: `${consoleReporters()} --reporter=junit --outputFile=../../${vitestLane.junitPath}`,
    };
  }
  const spec = `${shard.index}/${shard.count}`;
  return {
    // Read by apps/frontend/vitest.config.ts, which drops its coverage
    // thresholds when it is set. `--reporter=blob` does not do that on its own.
    MANGOSTUDIO_TEST_SHARD: spec,
    MANGOSTUDIO_BUN_TEST_ARGS: `--shard=${spec}`,
    MANGOSTUDIO_VITEST_ARGS: `--shard=${spec} ${consoleReporters()} --reporter=blob --outputFile=.vitest-reports/blob-${shard.index}.json`,
  };
}
