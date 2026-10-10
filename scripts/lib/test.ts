import { WORKSPACES, type WorkspaceName } from './config';
import { TEST_LANES } from './test-lanes';

export type TestLaneTask = 'test:unit' | 'test:integration' | 'test:coverage';

/** `--shard=<index>/<count>`, already validated. */
export interface TestShard {
  readonly index: number;
  readonly count: number;
}

/**
 * Build a filtered Turbo test-lane command. `--log-order=stream` is
 * load-bearing on CI, not cosmetic: Turbo's default there buffers a task's
 * whole log until the task exits, so a `bun test` invocation that hangs
 * (oven-sh/bun#39709) leaves a job log with nothing from the lane that hung.
 * Streaming means the last line in the log is from the file that wedged.
 * // Usage: createTurboTestCommand('test:unit', ['api']);
 */
export function createTurboTestCommand(task: TestLaneTask, workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', task, '--ui=stream', '--log-order=stream', ...filters];
}

/**
 * The workspaces whose coverage lanes a `--shard=i/N` run may split. The
 * frontend is not one of them: Bun's LCOV is not union-mergeable across
 * shards, so its lane runs whole, in its own CI job (see `sharded` in
 * test-lanes.ts).
 * // Usage: createTurboTestCommand('test:coverage', shardedCoverageWorkspaces());
 */
export function shardedCoverageWorkspaces(): WorkspaceName[] {
  // De-duplicated: a workspace with several sharded lanes (api's unit and
  // integration) is still one turbo filter.
  return [
    ...new Set(
      TEST_LANES.filter((lane) => lane.sharded && lane.workspace !== 'root').map(
        (lane) => lane.workspace as WorkspaceName
      )
    ),
  ];
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

/** A lane `scripts/test.ts` can hand `--changed` to: a workspace, or the root scripts. */
export type ChangedLane = 'root' | WorkspaceName;

/** A package another lane imports by name — a workspace or the protocol SDK. */
type LinkedPackage = WorkspaceName | 'protocol';

/**
 * What each lane imports by package name, transitively, as declared by the
 * `@mangostudio/*` `workspace:*` entries in its manifest.
 * `scripts/tests/changed-lanes.unit.test.ts` derives the same closure from the
 * manifests and fails if this table drifts from them.
 */
export const CHANGED_LANE_DEPENDENCIES: Readonly<Record<ChangedLane, readonly LinkedPackage[]>> = {
  root: ['api', 'shared', 'protocol'],
  shared: ['protocol'],
  api: ['shared', 'protocol'],
  frontend: ['api', 'shared', 'protocol'],
};

/** How a lane runs under `--changed`: Bun-selected files, or every file. */
export interface ChangedLaneRun {
  readonly lane: ChangedLane;
  readonly mode: 'changed' | 'full';
  /** Why a `full` lane could not trust Bun's selection; null for `changed`. */
  readonly reason: string | null;
}

const MODULE_FILE = /\.(?:[cm]?[jt]sx?)$/;

function packageOwning(file: string): LinkedPackage | 'root' {
  const workspace = /^apps\/(frontend|api|shared)\//.exec(file)?.[1];
  if (workspace) return workspace as WorkspaceName;
  return file.startsWith('packages/protocol/') ? 'protocol' : 'root';
}

function fullRunReason(lane: ChangedLane, files: readonly string[]): string | null {
  for (const file of files) {
    const owner = packageOwning(file);
    if (owner !== 'root' && CHANGED_LANE_DEPENDENCIES[lane].includes(owner)) {
      return `${file} is in ${owner}, which ${lane} imports by package name`;
    }
    // The root lane polices repository files (workflows, docs, manifests) by
    // reading them, so any non-module change anywhere is one it cannot trace.
    if (!MODULE_FILE.test(file) && (lane === 'root' || owner === lane)) {
      return `${file} is not a module, so Bun cannot trace its importers`;
    }
  }
  return null;
}

/**
 * Decide how each lane runs for `bun run test --changed`.
 *
 * `bun test --changed` walks the module graph from the changed files to the
 * test files, but it stops at a workspace symlink: an edit under apps/shared
 * selects no api or frontend test even though both import it (measured on Bun
 * 1.4.2), and a file that is read rather than imported (a manifest, a fixture,
 * a workflow) selects nothing at all. A lane whose changes reach it in either
 * way runs whole; every other lane gets `--changed` and lets Bun choose.
 *
 * @example
 * planChangedLanes(['apps/shared/src/errors/index.ts'], ['api', 'shared']);
 * // [{ lane: 'api', mode: 'full', reason: '… imports by package name' },
 * //  { lane: 'shared', mode: 'changed', reason: null }]
 */
export function planChangedLanes(
  files: readonly string[],
  lanes: readonly ChangedLane[]
): ChangedLaneRun[] {
  return lanes.map((lane) => {
    const reason = fullRunReason(lane, files);
    return { lane, mode: reason ? 'full' : 'changed', reason };
  });
}

/**
 * The `bun test` argument that scopes a lane to the files changed since `base`,
 * forwarded through Turbo after `--`.
 * // Usage: [...createTurboTestCommand('test:unit', ['shared']), '--', changedTestArg(sha)];
 */
export function changedTestArg(base: string): string {
  if (base.trim() === '' || base.startsWith('-')) {
    throw new Error(
      `Invalid --changed base: '${base}'. Expected a git ref or sha, e.g. origin/main.`
    );
  }
  return `--changed=${base}`;
}

/**
 * The Turbo commands that run one test task for the planned workspace lanes:
 * one scoped with `--changed=<base>` for the lanes Bun can select for, one
 * unscoped for the lanes that must run whole. Either is omitted when empty;
 * the root lane is not a Turbo workspace filter and is left to the caller.
 * // Usage: createChangedTurboTestCommands('test:unit', planChangedLanes(files, lanes), base);
 */
export function createChangedTurboTestCommands(
  task: TestLaneTask,
  runs: readonly ChangedLaneRun[],
  base: string
): string[][] {
  const workspacesIn = (mode: ChangedLaneRun['mode']): WorkspaceName[] =>
    runs.flatMap((run) => (run.mode === mode && run.lane !== 'root' ? [run.lane] : []));
  const scoped = workspacesIn('changed');
  const whole = workspacesIn('full');
  const commands: string[][] = [];
  if (scoped.length > 0) {
    commands.push([...createTurboTestCommand(task, scoped), '--', changedTestArg(base)]);
  }
  if (whole.length > 0) commands.push(createTurboTestCommand(task, whole));
  return commands;
}
