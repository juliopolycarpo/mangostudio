import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTurboCheckCommand, TYPECHECK_TASK } from '../lib/check';
import { ROOT_DIR } from '../lib/config';
import { protocolCheckTasks } from '../protocol/tasks';
import {
  FIXTURE_COMMAND_TIMEOUT_MS,
  FIXTURE_STOP_TIMEOUT_MS,
  FixtureCommands,
} from './support/fixture-command';
import { executableTaskIds, runTurbo, turboDryRun } from './support/turbo-run';
import {
  findClosureViolations,
  readWorkspaceManifests,
  typecheckClosure,
  typecheckTaskId,
  type WorkspaceManifest,
} from './support/typecheck-closure';
import { createTypecheckFixture, type TypecheckFixture } from './support/typecheck-fixture';

const commands = new FixtureCommands();
const COMMAND_BUDGET_MS = FIXTURE_COMMAND_TIMEOUT_MS + FIXTURE_STOP_TIMEOUT_MS;
afterEach(() => commands.settle(), COMMAND_BUDGET_MS + 5_000);

const PROTOCOL = '@mangostudio/protocol';
const SHARED = '@mangostudio/shared';
const API = '@mangostudio/api';
const FRONTEND = '@mangostudio/frontend';

/** The workspaces each command is filtered to, and the Turbo arguments it passes. */
const CHECK_RUNS: Record<string, { filtered: string[]; args: string[] }> = {
  full: {
    filtered: [FRONTEND, API, SHARED],
    args: createTurboCheckCommand(['frontend', 'api', 'shared']).slice(1),
  },
  frontend: { filtered: [FRONTEND], args: createTurboCheckCommand(['frontend']).slice(1) },
  api: { filtered: [API], args: createTurboCheckCommand(['api']).slice(1) },
  shared: { filtered: [SHARED], args: createTurboCheckCommand(['shared']).slice(1) },
  // The protocol is not a `WorkspaceName`; its lane filters it explicitly.
  protocol: {
    filtered: [PROTOCOL],
    args: (
      protocolCheckTasks(['--ts-only'], { cargo: false, cargoHack: false }).find(
        (task) => task.label === 'protocol:workspace'
      )?.cmd ?? []
    ).slice(1),
  },
};

/**
 * Every executable task a filtered check must retain, including the upstream
 * typechecks. Hashing an upstream workspace alone does not check it.
 */
const EXPECTED_CHECK_TASKS: Record<string, string[]> = {
  full: [
    `${API}#check:cycles`,
    `${API}#check:quick`,
    `${API}#typecheck`,
    `${FRONTEND}#check:cycles`,
    `${FRONTEND}#check:quick`,
    `${FRONTEND}#typecheck`,
    `${PROTOCOL}#typecheck`,
    `${SHARED}#check:cycles`,
    `${SHARED}#check:quick`,
    `${SHARED}#typecheck`,
  ],
  frontend: [
    `${API}#typecheck`,
    `${FRONTEND}#check:cycles`,
    `${FRONTEND}#check:quick`,
    `${FRONTEND}#typecheck`,
    `${PROTOCOL}#typecheck`,
    `${SHARED}#typecheck`,
  ],
  api: [
    `${API}#check:cycles`,
    `${API}#check:quick`,
    `${API}#typecheck`,
    `${PROTOCOL}#typecheck`,
    `${SHARED}#typecheck`,
  ],
  shared: [
    `${PROTOCOL}#typecheck`,
    `${SHARED}#check:cycles`,
    `${SHARED}#check:quick`,
    `${SHARED}#typecheck`,
  ],
  protocol: [`${PROTOCOL}#check:cycles`, `${PROTOCOL}#check:quick`, `${PROTOCOL}#typecheck`],
};

describe('typecheck closure guard', () => {
  const manifest = (overrides: Partial<WorkspaceManifest>): WorkspaceManifest => ({
    directory: 'apps/api',
    packageName: API,
    hasTypecheckScript: true,
    hasUnitTestScript: false,
    dependencyNames: [],
    ...overrides,
  });
  const shared = manifest({ directory: 'apps/shared', packageName: SHARED });

  test('reaches a dependency through a workspace that has no typecheck script', () => {
    const cli = manifest({
      directory: 'packages/cli',
      packageName: 'mangostudio',
      hasTypecheckScript: false,
      hasUnitTestScript: false,
      dependencyNames: [SHARED],
    });
    const api = manifest({ dependencyNames: ['mangostudio', 'elysia'] });

    expect(typecheckClosure([api, cli, shared], [API])).toEqual([
      typecheckTaskId(API),
      typecheckTaskId(SHARED),
    ]);
  });

  test('accepts a run that executed exactly the closure', () => {
    const api = manifest({ dependencyNames: [SHARED] });

    expect(
      findClosureViolations(
        [api, shared],
        [API],
        [typecheckTaskId(API), typecheckTaskId(SHARED), `${API}#check:quick`]
      )
    ).toEqual([]);
  });

  test('names the filtered workspace and the dependency a run left out', () => {
    const api = manifest({ dependencyNames: [SHARED] });

    expect(findClosureViolations([api, shared], [API], [typecheckTaskId(API)])).toEqual([
      `expected a run filtered to ${API} to execute ${SHARED}#typecheck, which its manifests depend on | received: ${API}#typecheck`,
    ]);
  });

  test('names a typecheck that is not a workspace dependency', () => {
    expect(
      findClosureViolations(
        [manifest({}), shared],
        [API],
        [typecheckTaskId(API), typecheckTaskId(SHARED)]
      )
    ).toEqual([
      `expected a run filtered to ${API} to execute only [${API}#typecheck] | received: ${SHARED}#typecheck`,
    ]);
  });
});

describe('typecheck task graph', () => {
  const manifests = readWorkspaceManifests();

  for (const [filter, run] of Object.entries(CHECK_RUNS)) {
    test(
      `a ${filter} run executes lint, cycles and every dependency's typecheck`,
      async () => {
        const received = executableTaskIds(await turboDryRun(ROOT_DIR, run.args, commands.run));

        const violations = findClosureViolations(manifests, run.filtered, received);
        expect(violations, violations.join(' ; ')).toEqual([]);
        expect(
          received,
          `expected the ${filter} run to execute: ${EXPECTED_CHECK_TASKS[filter].join(', ')} | received: ${received.join(', ')}`
        ).toEqual(EXPECTED_CHECK_TASKS[filter]);
      },
      COMMAND_BUDGET_MS + 5_000
    );
  }

  test(
    'no typecheck waits for another typecheck',
    async () => {
      const tasks = await turboDryRun(ROOT_DIR, CHECK_RUNS.full.args, commands.run);
      const executable = new Set(executableTaskIds(tasks));

      for (const task of tasks.filter((entry) => entry.task === 'typecheck')) {
        const waitsFor = task.dependencies.filter((id) => executable.has(id));
        expect(
          waitsFor,
          `expected ${task.taskId} to start with no executable dependency | received: waits for ${waitsFor.join(', ')}`
        ).toEqual([]);
      }
    },
    COMMAND_BUDGET_MS + 5_000
  );

  test(
    'the transit task declares no inputs, so an upstream manifest or tsconfig edit reaches downstream hashes',
    async () => {
      const tasks = await turboDryRun(ROOT_DIR, CHECK_RUNS.full.args, commands.run);

      for (const task of tasks.filter((entry) => entry.task === 'transit')) {
        const declared = task.resolvedTaskDefinition.inputs;
        expect(
          declared,
          `expected ${task.taskId} to declare no inputs, so Turbo hashes every tracked file of ${task.directory} | received inputs: [${declared.join(', ')}]`
        ).toEqual([]);

        const hashed = Object.keys(task.inputs);
        const expected = ['package.json', 'tsconfig.json'].filter((file) =>
          existsSync(join(ROOT_DIR, task.directory, file))
        );
        for (const file of expected) {
          expect(
            hashed,
            `expected ${task.taskId} to hash ${task.directory}/${file}, so an edit to it invalidates every dependent typecheck | received ${hashed.length} hashed files without it`
          ).toContain(file);
        }
      }
    },
    COMMAND_BUDGET_MS + 5_000
  );

  test(
    'the transit task runs no script, so it hashes upstream sources without running anything',
    async () => {
      const tasks = await turboDryRun(ROOT_DIR, CHECK_RUNS.full.args, commands.run);
      const transit = tasks.filter((task) => task.task === 'transit');

      expect(
        transit.length,
        'expected a transit task in every workspace of the full run | received: none'
      ).toBeGreaterThanOrEqual(4);
      for (const task of transit) {
        expect(
          task.command,
          `expected ${task.taskId} to have no script behind it | received command: ${task.command}`
        ).toBe('<NONEXISTENT>');
      }
    },
    COMMAND_BUDGET_MS + 5_000
  );
});

describe('typecheck cache across workspaces', () => {
  let fixture: TypecheckFixture;
  const check = (extra: string[] = []) =>
    runTurbo(
      fixture.root,
      ['run', TYPECHECK_TASK, ...fixture.turboArgs, ...extra],
      {},
      commands.run
    );

  const typecheckHashes = async (): Promise<Map<string, string>> => {
    const tasks = await turboDryRun(
      fixture.root,
      ['run', TYPECHECK_TASK, ...fixture.turboArgs],
      commands.run
    );
    return new Map(
      tasks.filter((task) => task.task === 'typecheck').map((task) => [task.taskId, task.hash])
    );
  };

  // Each workspace's check reads its own sources and those of every workspace it imports.
  const REBUILT_BY: Record<string, string[]> = {
    [PROTOCOL]: [PROTOCOL, SHARED, API, FRONTEND],
    [SHARED]: [SHARED, API, FRONTEND],
    [API]: [API, FRONTEND],
    [FRONTEND]: [FRONTEND],
  };

  beforeAll(() => {
    fixture = createTypecheckFixture();
  });
  afterAll(async () => {
    await commands.settle();
    fixture.dispose();
  }, COMMAND_BUDGET_MS + 5_000);

  for (const [edited, rebuilt] of Object.entries(REBUILT_BY)) {
    test(
      `editing ${edited} invalidates exactly the typechecks that read it`,
      async () => {
        const before = await typecheckHashes();
        fixture.writeSource(edited, '// an unrelated edit\n');
        const after = await typecheckHashes();
        fixture.writeSource(edited);

        const changed = [...after.keys()].filter((id) => after.get(id) !== before.get(id)).sort();
        const expected = rebuilt.map(typecheckTaskId).sort();
        expect(
          changed,
          `expected an edit in ${edited} to change the typecheck hash of: ${expected.join(', ')} | received: changed ${changed.join(', ')}`
        ).toEqual(expected);
      },
      2 * COMMAND_BUDGET_MS + 5_000
    );
  }

  test(
    'an upstream type error fails the run and no downstream typecheck is served from cache',
    async () => {
      const cold = await check();
      expect(
        cold.exitCode,
        `expected a cold typecheck run to exit: 0 | received: ${cold.exitCode} | output: ${cold.stdout}${cold.stderr}`
      ).toBe(0);
      const warm = await check();
      expect(
        cacheHits(warm.stdout),
        `expected every typecheck of a warm run to be a cache hit | received output: ${warm.stdout}`
      ).toEqual(fixture.packageNames.map(typecheckTaskId).sort());

      fixture.breakSource(PROTOCOL);
      // `--continue=always` lets every workspace report, not only the first to fail.
      const broken = await check(['--continue=always']);
      expect(
        broken.exitCode,
        `expected a type error in ${PROTOCOL} to fail the run | received exit: ${broken.exitCode} | output: ${broken.stdout}`
      ).not.toBe(0);
      expect(
        cacheHits(broken.stdout),
        `expected no typecheck to be served from cache after a type error in ${PROTOCOL} | received hits: ${cacheHits(broken.stdout).join(', ')}`
      ).toEqual([]);
      for (const workspace of [SHARED, API, FRONTEND]) {
        expect(
          failedTasks(broken.stdout),
          `expected ${typecheckTaskId(workspace)} to fail on the ${PROTOCOL} type error it reads | received failures: ${failedTasks(broken.stdout).join(', ')}`
        ).toContain(typecheckTaskId(workspace));
      }
    },
    3 * COMMAND_BUDGET_MS + 5_000
  );

  test(
    'a type error reported after a downstream typecheck has passed still fails the run',
    async () => {
      // The frontend never reads this file, so its check passes at once while
      // the api's is still running. A graph that stopped the api's check when the
      // frontend's finished would exit 0 here.
      const own = createTypecheckFixture();
      try {
        own.breakPrivateSlowly(API);
        const run = await runTurbo(
          own.root,
          ['run', TYPECHECK_TASK, ...own.turboArgs],
          {},
          commands.run
        );

        expect(
          run.exitCode,
          `expected a late type error in ${API} to fail the run although ${FRONTEND} passed first | received exit: ${run.exitCode} | output: ${run.stdout}`
        ).not.toBe(0);
        expect(failedTasks(run.stdout)).toEqual([typecheckTaskId(API)]);
      } finally {
        await commands.settle();
        own.dispose();
      }
    },
    COMMAND_BUDGET_MS + 5_000
  );
});

/** `turbo run` stream-mode lines of tasks restored from cache, as task ids. */
function cacheHits(output: string): string[] {
  return [...output.matchAll(/^(\S+?):typecheck: cache hit/gm)]
    .map((match) => typecheckTaskId(match[1]))
    .sort();
}

/** Task ids that printed the fake checker's error line. */
function failedTasks(output: string): string[] {
  return [...output.matchAll(/^(\S+?):typecheck: .*error TS2322/gm)]
    .map((match) => typecheckTaskId(match[1]))
    .sort();
}
