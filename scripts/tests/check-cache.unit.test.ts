import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createTurboCheckCommand, createWorkspaceCycleCommand } from '../lib/check';
import { ROOT_DIR, type WorkspaceName } from '../lib/config';
import { PASS_STAMP_DIR, readPassStamp } from '../lib/pass-stamp';
import { protocolCheckTasks } from '../protocol/tasks';
import {
  FIXTURE_COMMAND_TIMEOUT_MS,
  FIXTURE_STOP_TIMEOUT_MS,
  FixtureCommands,
} from './support/fixture-command';
import { hermeticTurboEnv, runTurbo, turboDryRun } from './support/turbo-run';
import { createTypecheckFixture, type TypecheckFixture } from './support/typecheck-fixture';

const WORKSPACES = ['apps/api', 'apps/frontend', 'apps/shared', 'packages/protocol'];
const fixtures: TypecheckFixture[] = [];
const commands = new FixtureCommands();
// Each cache replay case runs three commands in sequence. The Bun test deadline
// must leave each command its own execution and tree-stop allowance, plus setup.
const COMMAND_BUDGET_MS = FIXTURE_COMMAND_TIMEOUT_MS + FIXTURE_STOP_TIMEOUT_MS;
const CACHE_CHECK_TIMEOUT_MS = 3 * COMMAND_BUDGET_MS + 5_000;
const ROOT_CHECK_TIMEOUT_MS = CACHE_CHECK_TIMEOUT_MS;

/** Real lint/cycle scripts and Turbo config, with only tsc replaced by the existing fake. */
function createFixture(options: { track?: boolean } = {}): TypecheckFixture {
  const fixture = createTypecheckFixture();
  // A fixture shared across tests is disposed by its own `afterAll`, not after each test.
  if (options.track !== false) fixtures.push(fixture);
  const { root } = fixture;
  for (const file of ['bunfig.toml', '.editorconfig', '.gitignore', 'tsconfig.json']) {
    copyFileSync(join(ROOT_DIR, file), join(root, file));
  }
  cpSync(join(ROOT_DIR, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  for (const file of [
    'scripts/check.ts',
    'scripts/check-import-cycles.ts',
    'scripts/check-source-scan.ts',
  ]) {
    copyFileSync(join(ROOT_DIR, file), join(root, file));
  }
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  rootManifest.scripts = { check: 'bun ./scripts/check.ts' };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`);
  for (const workspace of WORKSPACES) {
    const path = join(root, workspace, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const realManifest = JSON.parse(
      readFileSync(join(ROOT_DIR, workspace, 'package.json'), 'utf8')
    );
    for (const script of ['check', 'check:quick', 'check:cycles']) {
      manifest.scripts[script] = realManifest.scripts[script];
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    copyFileSync(
      join(ROOT_DIR, workspace, 'tsconfig.json'),
      join(root, workspace, 'tsconfig.json')
    );
    if (workspace.startsWith('apps/')) {
      for (const file of ['AGENTS.md', 'bunfig.toml']) {
        copyFileSync(join(ROOT_DIR, workspace, file), join(root, workspace, file));
      }
    }
  }
  symlinkSync(join(ROOT_DIR, 'node_modules'), join(root, 'node_modules'), 'junction');
  for (const cmd of [
    ['git', 'init', '-q'],
    ['git', 'add', '.'],
  ]) {
    const result = Bun.spawnSync(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, `${cmd.join(' ')}: ${result.stderr}`).toBe(0);
  }
  return fixture;
}

/**
 * The repository's required check for one workspace: the cached Turbo tasks, then
 * the cycle scan that always runs outside Turbo. The result fails when either does.
 * @example
 * const run = await requiredCheck(fixture, 'apps/api');
 */
async function requiredCheck(fixture: TypecheckFixture, workspace: string) {
  const isProtocol = workspace === 'packages/protocol';
  const protocolTasks = protocolCheckTasks(['--ts-only'], { cargo: false, cargoHack: false });
  const turboCommand = isProtocol
    ? protocolTasks.find((task) => task.label === 'protocol:workspace')?.cmd
    : createTurboCheckCommand([workspace.slice(5) as WorkspaceName]);
  expect(turboCommand?.[0]).toBe('turbo');
  const cycleCommand = isProtocol
    ? protocolTasks.find((task) => task.label === 'protocol:cycles')?.cmd
    : createWorkspaceCycleCommand(workspace.slice(5) as WorkspaceName);
  expect(cycleCommand?.slice(0, 2)).toEqual(['bun', 'scripts/check-import-cycles.ts']);
  const turbo = await runTurbo(
    fixture.root,
    [
      ...(turboCommand?.slice(1) ?? []),
      ...fixture.turboArgs.filter((arg) => !arg.startsWith('--ui=')),
    ],
    {},
    commands.run
  );
  const cycles = await commands.run(cycleCommand ?? [], fixture.root);
  return {
    exitCode: turbo.exitCode === 0 ? cycles.exitCode : turbo.exitCode,
    stdout: turbo.stdout + cycles.stdout,
    stderr: turbo.stderr + cycles.stderr,
  };
}

function rootCheck(
  fixture: TypecheckFixture,
  workspace: WorkspaceName,
  extra: { args?: string[]; env?: Record<string, string> } = {}
) {
  return commands.run(
    ['bun', 'run', 'check', `--${workspace}`, ...(extra.args ?? [])],
    fixture.root,
    hermeticTurboEnv({ TURBO_CACHE_DIR: join(fixture.root, '.turbo-cache'), ...extra.env })
  );
}

function expectOutcome(
  run: { exitCode: number; stdout: string; stderr: string },
  outcome: 'pass' | 'fail'
): string {
  const output = run.stdout + run.stderr;
  expect(run.exitCode === 0, `expected ${outcome}, received exit ${run.exitCode}\n${output}`).toBe(
    outcome === 'pass'
  );
  return Bun.stripANSI(output);
}

afterEach(async () => {
  await commands.settle();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
}, COMMAND_BUDGET_MS + 5_000);

describe('lint cache and required cycle scans', () => {
  const cycles = [
    {
      name: 'self-import',
      files: {
        'a.ts': "import { cycle as self } from './a';\nexport const cycle = () => self();\n",
      },
      rule: 'import/no-self-import',
    },
    {
      name: 'value cycle',
      files: {
        'a.ts': "import { b } from './b';\nexport const a = () => b();\n",
        'b.ts': "import { a } from './a';\nexport const b = () => a();\n",
      },
      rule: 'import/no-cycle',
    },
    {
      name: 'type-only cycle',
      files: {
        'a.ts': "import type { B } from './b';\nexport type A = { b?: B };\n",
        'b.ts': "import type { A } from './a';\nexport type B = { a?: A };\n",
      },
      rule: 'import/no-cycle',
    },
  ];
  // One fixture and one warm pass per workspace, shared by its cycle cases. The
  // warm pass is not what a case tests: it only has to leave a cached lint hit
  // behind. Each case adds its ignored files, and removes them again, so the next
  // case starts from the same warm tree (the removed files were never lint
  // inputs, so the cached lint still hits). On Windows each command costs seconds,
  // and a fixture and warm pass per case made this the slowest file of the lane.
  for (const workspace of WORKSPACES) {
    describe(`${workspace} cached lint replay`, () => {
      let shared: TypecheckFixture | undefined;
      let packageName = '';
      beforeAll(async () => {
        shared = createFixture({ track: false });
        packageName = JSON.parse(
          readFileSync(join(shared.root, workspace, 'package.json'), 'utf8')
        ).name;
        expectOutcome(await requiredCheck(shared, workspace), 'pass');
      }, CACHE_CHECK_TIMEOUT_MS);
      afterAll(async () => {
        await commands.settle();
        shared?.dispose();
      }, COMMAND_BUDGET_MS + 5_000);

      for (const cycle of cycles) {
        test(
          `${workspace} rejects a new ignored ${cycle.name} while replaying cached lint`,
          async () => {
            if (!shared)
              throw new Error(
                `(check cache): expected a warm ${workspace} fixture | received: none`
              );
            const buildDir = join(shared.root, workspace, 'build');
            try {
              for (const [file, source] of Object.entries(cycle.files)) {
                await Bun.write(join(buildDir, file), source);
              }
              for (let attempt = 0; attempt < 2; attempt++) {
                const rejected = expectOutcome(await requiredCheck(shared, workspace), 'fail');
                expect(rejected).toContain(`${packageName}:check:quick: cache hit`);
                expect(rejected).toContain(cycle.rule);
                expect(rejected.replaceAll('\\', '/')).toContain('build/a.ts');
              }
            } finally {
              rmSync(buildDir, { recursive: true, force: true });
            }
          },
          2 * CACHE_CHECK_TIMEOUT_MS
        );
      }
    });
  }

  test(
    'root check reports isolated tooling cycles even with formatting skipped',
    async () => {
      const fixture = createFixture();
      for (const file of [
        '.claude/hooks/leaf.ts',
        'tests/browser-smoke/leaf.ts',
        'playwright.config.ts',
        'apps/frontend/build.ts',
      ]) {
        mkdirSync(dirname(join(fixture.root, file)), { recursive: true });
        writeFileSync(join(fixture.root, file), 'export {};\n');
      }
      const report = join(fixture.root, 'root-report.json');
      const run = async () => {
        const result = await commands.run(
          [
            'bun',
            './scripts/check.ts',
            '--root',
            '--skip-format',
            '--report-file',
            report,
            '--report-id',
            '8f92b9cc-267b-4b95-b3af-d9c6637660e8',
          ],
          fixture.root
        );
        const parsed = JSON.parse(readFileSync(report, 'utf8')) as {
          tasks: { label: string; state: string; exitCode?: number }[];
        };
        return { result, cycle: parsed.tasks.find((task) => task.label === 'root:cycles') };
      };
      // Other root policies use application manifests absent from this small fixture.
      // Assert the required task's own result so they cannot cause an incidental pass.
      const before = await run();
      expect(before.cycle, before.result.stdout + before.result.stderr).toMatchObject({
        state: 'executed',
        exitCode: 0,
      });
      await Bun.write(
        join(fixture.root, 'scripts/isolated-a.ts'),
        "import type { B } from './isolated-b';\nexport type A = { b?: B };\n"
      );
      await Bun.write(
        join(fixture.root, 'scripts/isolated-b.ts'),
        "import type { A } from './isolated-a';\nexport type B = { a?: A };\n"
      );
      const after = await run();
      expect(after.cycle).toMatchObject({ state: 'executed', exitCode: 1 });
      expect(after.result.stdout + after.result.stderr).toContain('scripts/isolated-a.ts');
    },
    ROOT_CHECK_TIMEOUT_MS
  );

  test(
    'an ignored cycle introduced after a warm pass reaches the root check exit',
    async () => {
      const fixture = createFixture();
      expectOutcome(await rootCheck(fixture, 'frontend'), 'pass');
      expectOutcome(await rootCheck(fixture, 'frontend'), 'pass');
      await Bun.write(
        join(fixture.root, 'apps/frontend/build/new-cycle.ts'),
        "import { cycle as self } from './new-cycle';\nexport const cycle = () => self();\n"
      );
      const rejected = expectOutcome(await rootCheck(fixture, 'frontend'), 'fail');
      expect(rejected).toMatch(/@mangostudio\/frontend:check:quick(?:: |\r?\n)cache hit/);
      expect(rejected).toContain('import/no-self-import');
      expect(rejected.replaceAll('\\', '/')).toContain('build/new-cycle.ts');
    },
    ROOT_CHECK_TIMEOUT_MS
  );

  test(
    'a lint failure invalidates a warm pass and reaches the root check exit',
    async () => {
      const fixture = createFixture();
      expectOutcome(await rootCheck(fixture, 'frontend'), 'pass');
      fixture.writeSource('@mangostudio/frontend', 'export const bad=2;\n');
      const rejected = expectOutcome(await rootCheck(fixture, 'frontend'), 'fail');
      // GitHub Actions groups a task under its own header instead of prefixing
      // each line as a local streamed run does. Require the same task/cache state.
      expect(rejected).toMatch(/@mangostudio\/frontend:check:quick(?:: |\r?\n)cache miss/);
      expect(rejected).toContain('format');
      expect(rejected.replaceAll('\\', '/')).toContain('src/index.ts');
    },
    ROOT_CHECK_TIMEOUT_MS
  );

  test(
    'an upstream typecheck failure still reaches the root check exit',
    async () => {
      const fixture = createFixture();
      expectOutcome(await rootCheck(fixture, 'frontend'), 'pass');
      fixture.breakSource('@mangostudio/protocol');
      const rejected = expectOutcome(await rootCheck(fixture, 'frontend'), 'fail');
      expect(rejected).toContain('@mangostudio/protocol:typecheck');
      expect(rejected).toContain('error TS2322');
    },
    ROOT_CHECK_TIMEOUT_MS
  );
});

describe('source scan pass stamps', () => {
  // `CI` unset so the stamps are on whatever runs this file. Turbo's cache lives
  // outside the fixture: a cache written under it during a scan is an untracked
  // JSON file the scan's key sees, and the pass is then correctly not recorded.
  const turboCaches: string[] = [];
  const localEnv = () => {
    const cache = mkdtempSync(join(tmpdir(), 'mango-check-stamp-turbo-'));
    turboCaches.push(cache);
    return { env: { CI: '', TURBO_CACHE_DIR: cache } };
  };
  afterEach(() => {
    for (const cache of turboCaches.splice(0)) rmSync(cache, { recursive: true, force: true });
  });
  const replayed = (output: string, label: string): boolean =>
    new RegExp(`${label} \\(replayed [0-9a-f]{12}\\)`).test(output);

  test(
    'replays an unchanged scan, runs it again with --force, and runs it after a source edit',
    async () => {
      const fixture = createFixture();
      const LOCAL = localEnv();
      const first = expectOutcome(await rootCheck(fixture, 'frontend', LOCAL), 'pass');
      expect(
        replayed(first, 'frontend:cycles'),
        `(check): expected a first run | received:\n${first}`
      ).toBe(false);

      const second = expectOutcome(await rootCheck(fixture, 'frontend', LOCAL), 'pass');
      for (const label of [
        'frontend:cycles',
        'frontend:api-import-boundary',
        'root:shared-import-boundary',
      ]) {
        expect(
          replayed(second, label),
          `(check): expected ${label} replayed | received:\n${second}`
        ).toBe(true);
      }

      const forced = expectOutcome(
        await rootCheck(fixture, 'frontend', { ...LOCAL, args: ['--force'] }),
        'pass'
      );
      expect(forced, '(check --force): expected no replay | received a replay').not.toContain(
        '(replayed'
      );

      fixture.writeSource('@mangostudio/frontend', 'export const edited = 1;\n');
      const edited = expectOutcome(await rootCheck(fixture, 'frontend', LOCAL), 'pass');
      expect(
        replayed(edited, 'frontend:cycles'),
        `(check): expected a rerun after an edit | received:\n${edited}`
      ).toBe(false);
    },
    4 * COMMAND_BUDGET_MS + 5_000
  );

  test(
    'a report run never replays a scan',
    async () => {
      const fixture = createFixture();
      const LOCAL = localEnv();
      // Outside the fixture, or the report's own snapshots would change a scan's key.
      const report = join(LOCAL.env.TURBO_CACHE_DIR, 'report.json');
      // An ordinary run first, so the report run has a stamp it could replay. Without
      // it the test passes even if report runs read stamps.
      const ordinary = await rootCheck(fixture, 'frontend', LOCAL);
      expectOutcome(ordinary, 'pass');
      expect(
        readPassStamp(join(fixture.root, PASS_STAMP_DIR), 'frontend:cycles'),
        '(check): expected the ordinary run to record a frontend:cycles stamp | received: none'
      ).not.toBeNull();

      expectOutcome(
        await rootCheck(fixture, 'frontend', {
          ...LOCAL,
          args: ['--report-file', report, '--report-id', '8f92b9cc-267b-4b95-b3af-d9c6637660e8'],
        }),
        'pass'
      );
      const parsed = JSON.parse(readFileSync(report, 'utf8')) as {
        tasks: { label: string; state: string }[];
      };
      expect(
        parsed.tasks.filter((task) => task.label.includes('replayed')),
        '(check report): expected no replayed task | received one'
      ).toEqual([]);
      expect(parsed.tasks.find((task) => task.label === 'frontend:cycles')).toMatchObject({
        state: 'executed',
      });
    },
    2 * COMMAND_BUDGET_MS + 5_000
  );
});

describe('lint cache inputs', () => {
  for (const file of [
    'bunfig.toml',
    '.editorconfig',
    '.gitignore',
    'tsconfig.json',
    'turbo.jsonc',
    'apps/frontend/tsconfig.json',
    'apps/frontend/package.json',
    'apps/frontend/src/index.ts',
    'apps/shared/src/index.ts',
    'packages/protocol/src/index.ts',
  ]) {
    test(
      `editing ${file} invalidates frontend lint`,
      async () => {
        const fixture = createFixture();
        const args = ['run', 'check:quick', '--filter=@mangostudio/frontend', ...fixture.turboArgs];
        const hash = async () => {
          const task = (await turboDryRun(fixture.root, args, commands.run)).find(
            (task) => task.taskId === '@mangostudio/frontend#check:quick'
          );
          expect(task, 'frontend lint must be selected').toBeDefined();
          return task?.hash;
        };
        const before = await hash();
        const path = join(fixture.root, file);
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
        expect(await hash(), `${file} changed but frontend lint retained its hash`).not.toBe(
          before
        );
      },
      2 * COMMAND_BUDGET_MS + 5_000
    );
  }
});
