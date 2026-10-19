import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { checkReportTarget, writeCheckReport } from '../lib/check-report';
import { parseCheckResult } from '../lib/check-result';
import { ROOT_DIR } from '../lib/config';
import { CHECK_INVOCATION_ID, completedCheckFixture } from './support/check-result-fixture';

const temporary = () => mkdtempSync(join(tmpdir(), 'mango-check-cli-'));

describe('Check report file adapter', () => {
  test('report output is optional and report flags are removed from caller arguments', () => {
    expect(checkReportTarget(['--api'], {})).toBeNull();
    expect(
      checkReportTarget(
        [
          '--api',
          '--report-file',
          '/tmp/report.json',
          `--report-id=${CHECK_INVOCATION_ID}`,
          '--skip-format',
        ],
        { '--report-file': '/tmp/report.json', '--report-id': CHECK_INVOCATION_ID }
      )
    ).toEqual({
      path: '/tmp/report.json',
      invocationId: CHECK_INVOCATION_ID,
      args: ['--api', '--skip-format'],
    });
  });

  test('half-specified or invalid report identity fails setup', () => {
    expect(() => checkReportTarget([], { '--report-file': 'report.json' })).toThrow(
      'supplied together'
    );
    expect(() => checkReportTarget([], { '--report-id': CHECK_INVOCATION_ID })).toThrow(
      'supplied together'
    );
    expect(() =>
      checkReportTarget([], { '--report-file': 'report.json', '--report-id': 'bad' })
    ).toThrow('UUID');
  });

  test('atomically replaces a pending report with a validated completed result', () => {
    const directory = temporary();
    try {
      const path = join(directory, 'result.json');
      const fixture = completedCheckFixture();
      const target = { path, invocationId: CHECK_INVOCATION_ID, args: ['--all'] };
      writeCheckReport(target, {
        ...fixture,
        state: 'unavailable',
        exitCode: 1,
        error: 'Setup unfinished',
      });
      writeCheckReport(target, fixture);
      expect(parseCheckResult(readFileSync(path, 'utf8'), fixture)).toEqual(fixture);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * The ambient environment under a fixture's, which always sets `PATH`. Windows spells the
 * inherited key `Path`; keeping both would leave Check's env-less `git` lookup on the old one.
 */
const childEnvironment = (fixture: Record<string, string>) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')
  ),
  ...fixture,
});

const runCli = async (args: string[], environment: Record<string, string>, root: string) => {
  const child = Bun.spawn([process.execPath, './scripts/check.ts', ...args], {
    cwd: root,
    env: childEnvironment(environment),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const EXECUTABLE_EXTENSION = process.platform === 'win32' ? '.exe' : '';

/** Compiles the fake `turbo` and `bunx` once, into one directory for every CLI fixture's `PATH`. */
const compileFakeCheckTools = async (directory: string) => {
  const turbo = join(directory, `turbo${EXECUTABLE_EXTENSION}`);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'support', 'fake-check-tool.ts')],
    compile: {
      outfile: turbo,
      // The fake runs in a fixture root; its bunfig.toml and .env are not the fake's.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  expect(result.success, result.logs.map(String).join('\n')).toBe(true);
  // The fake reads its tool name from the path it was started by.
  linkSync(turbo, join(directory, `bunx${EXECUTABLE_EXTENSION}`));
};

const makeCliFixture = (fakeToolDirectory: string) => {
  const directory = temporary();
  mkdirSync(join(directory, 'scripts'));
  cpSync(join(ROOT_DIR, 'scripts/check.ts'), join(directory, 'scripts/check.ts'));
  cpSync(join(ROOT_DIR, 'scripts/lib'), join(directory, 'scripts/lib'), { recursive: true });
  // A junction needs no symlink privilege on Windows; POSIX ignores the type.
  symlinkSync(join(ROOT_DIR, 'node_modules'), join(directory, 'node_modules'), 'junction');
  writeFileSync(join(directory, '.gitignore'), '/node_modules/\n/scripts/\n');
  writeFileSync(join(directory, 'source.ts'), 'export const fixture = true;\n');
  const git = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: directory });
  if (!git.success) throw new Error(git.stderr.toString());
  return {
    directory,
    path: join(directory, 'result.json'),
    env: {
      PATH: `${fakeToolDirectory}${delimiter}${process.env.PATH}`,
      MANGO_RUNNER_CONCURRENCY: '2',
      CHECK_FIXTURE_TURBO_EXIT: '0',
      CHECK_FIXTURE_DPRINT_EXIT: '0',
    },
  };
};

// These fixture executables exercise the real Check CLI, including its summary,
// while leaving workspace commands deterministic and avoiding a second full gate.
describe('Check CLI result parity', () => {
  let fakeToolDirectory = '';

  beforeAll(async () => {
    fakeToolDirectory = mkdtempSync(join(tmpdir(), 'mango-fake-check-tool-'));
    await compileFakeCheckTools(fakeToolDirectory);
  }, 30_000);

  afterAll(() => {
    if (fakeToolDirectory) rmSync(fakeToolDirectory, { recursive: true, force: true });
  });

  test.each([
    ['success', '0', '0', 0],
    ['multiple task failures', '2', '7', 1],
  ])(
    '%s preserves human logs and exit with the report adapter enabled',
    async (_name, turbo, dprint, exitCode) => {
      const fixture = makeCliFixture(fakeToolDirectory);
      try {
        const env = {
          ...fixture.env,
          CHECK_FIXTURE_TURBO_EXIT: turbo,
          CHECK_FIXTURE_DPRINT_EXIT: dprint,
        };
        const ordinary = await runCli(['--api'], env, fixture.directory);
        const reported = await runCli(
          ['--api', '--report-file', fixture.path, '--report-id', CHECK_INVOCATION_ID],
          env,
          fixture.directory
        );
        const withoutTiming = (text: string) => text.replace(/\d+ms/g, '<duration>');
        expect(ordinary.exitCode).toBe(exitCode);
        expect(reported.exitCode).toBe(exitCode);
        expect(withoutTiming(reported.stdout)).toBe(withoutTiming(ordinary.stdout));
        expect(reported.stderr).toBe(ordinary.stderr);
        const report = parseCheckResult(readFileSync(fixture.path, 'utf8'), {
          invocationId: CHECK_INVOCATION_ID,
          args: ['--api'],
          exitCode,
        });
        expect(report.state).toBe('completed');
        expect(report.tasks.map((task) => task.label)).toEqual([
          'workspaces:check',
          'root:dprint:api',
          'root:shared-import-boundary',
        ]);
        expect(
          report.tasks
            .filter((task) => task.state === 'executed' && task.exitCode !== 0)
            .map((task) => task.label)
        ).toEqual(exitCode === 0 ? [] : ['workspaces:check', 'root:dprint:api']);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  );

  test('a subprocess setup failure keeps unavailable labels and the executed source scan', async () => {
    const fixture = makeCliFixture(fakeToolDirectory);
    try {
      const result = await runCli(
        ['--api', '--report-file', fixture.path, '--report-id', CHECK_INVOCATION_ID],
        { ...fixture.env, MANGO_RUNNER_CONCURRENCY: 'invalid' },
        fixture.directory
      );
      expect(result.exitCode).toBe(1);
      const report = parseCheckResult(readFileSync(fixture.path, 'utf8'), {
        invocationId: CHECK_INVOCATION_ID,
        args: ['--api'],
        exitCode: 1,
      });
      expect(report.state).toBe('unavailable');
      expect(report.tasks.map((task) => `${task.label}:${task.state}`)).toEqual([
        'workspaces:check:unavailable',
        'root:dprint:api:unavailable',
        'root:shared-import-boundary:executed',
      ]);
      expect(result.stderr).toContain('Invalid MANGO_RUNNER_CONCURRENCY');
      expect(result.stderr).toContain('2 task(s) failed.');
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test('a failed snapshot never relabels a finished task', async () => {
    const fixture = makeCliFixture(fakeToolDirectory);
    try {
      // Turbo blocks the report, so its snapshot fails. Dprint runs next and
      // unblocks it, so the final write must record every task as executed.
      const result = await runCli(
        ['--api', '--report-file', fixture.path, '--report-id', CHECK_INVOCATION_ID],
        {
          ...fixture.env,
          MANGO_RUNNER_CONCURRENCY: '1',
          CHECK_FIXTURE_BLOCK_REPORT: fixture.path,
          CHECK_FIXTURE_UNBLOCK_REPORT: fixture.path,
        },
        fixture.directory
      );
      expect(result.stderr).toContain('Check report snapshot not written:');
      expect(result.exitCode).toBe(0);
      const report = parseCheckResult(readFileSync(fixture.path, 'utf8'), {
        invocationId: CHECK_INVOCATION_ID,
        args: ['--api'],
        exitCode: 0,
      });
      expect(report.state).toBe('completed');
      expect(report.tasks.map((task) => `${task.label}:${task.state}`)).toEqual([
        'workspaces:check:executed',
        'root:dprint:api:executed',
        'root:shared-import-boundary:executed',
      ]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  // Windows has no POSIX directory permissions to lock the report with.
  test.skipIf(process.platform === 'win32')(
    'a report write that fails after setup keeps the original failure visible',
    async () => {
      const fixture = makeCliFixture(fakeToolDirectory);
      try {
        // The fake turbo task locks the report directory, so the first task
        // snapshot and the top-level fallback snapshot both fail to write.
        const result = await runCli(
          ['--api', '--report-file', fixture.path, '--report-id', CHECK_INVOCATION_ID],
          { ...fixture.env, CHECK_FIXTURE_LOCK_DIR: fixture.directory },
          fixture.directory
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Check report not written:');
      } finally {
        chmodSync(fixture.directory, 0o700);
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  );

  test('a CLI setup abort leaves an explicit unavailable report', async () => {
    const fixture = makeCliFixture(fakeToolDirectory);
    try {
      const result = await runCli(
        ['--unknown', '--report-file', fixture.path, '--report-id', CHECK_INVOCATION_ID],
        fixture.env,
        fixture.directory
      );
      expect(result.exitCode).toBe(1);
      const report = parseCheckResult(readFileSync(fixture.path, 'utf8'), {
        invocationId: CHECK_INVOCATION_ID,
        args: ['--unknown'],
        exitCode: 1,
      });
      expect(report.state).toBe('unavailable');
      expect(report.error).toBe('Check setup did not finish');
      expect(report.tasks).toEqual([]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  // Windows has no SIGTERM to deliver, so the signal exit is POSIX-only evidence.
  test.skipIf(process.platform === 'win32')(
    'interruption retains executed labels, unavailable labels and the signal exit',
    async () => {
      const fixture = makeCliFixture(fakeToolDirectory);
      const child = Bun.spawn(
        [
          process.execPath,
          './scripts/check.ts',
          '--api',
          '--report-file',
          fixture.path,
          '--report-id',
          CHECK_INVOCATION_ID,
        ],
        {
          cwd: fixture.directory,
          env: childEnvironment({
            ...fixture.env,
            MANGO_RUNNER_GROUP: '',
            CHECK_FIXTURE_TURBO_DELAY: 'yes',
          }),
          detached: true,
          stdout: 'ignore',
          stderr: 'pipe',
        }
      );
      const stderr = new Response(child.stderr).text();
      try {
        const deadline = Date.now() + 3000;
        let taskFinished = false;
        while (Date.now() < deadline) {
          try {
            const report = JSON.parse(readFileSync(fixture.path, 'utf8')) as {
              tasks: Array<{ label: string; state: string }>;
            };
            taskFinished = report.tasks.some(
              (task) => task.label === 'root:shared-import-boundary' && task.state === 'executed'
            );
          } catch {
            // Setup has not yet atomically published a report.
          }
          if (taskFinished) break;
          await Bun.sleep(10);
        }
        expect(taskFinished).toBe(true);
        child.kill('SIGTERM');
        const exitCode = await child.exited;
        expect(exitCode).toBe(143);
        const report = parseCheckResult(readFileSync(fixture.path, 'utf8'), {
          invocationId: CHECK_INVOCATION_ID,
          args: ['--api'],
          exitCode,
        });
        expect(report.state).toBe('unavailable');
        expect(report.tasks.find((task) => task.label === 'workspaces:check')?.state).toBe(
          'unavailable'
        );
        expect(
          report.tasks.find((task) => task.label === 'root:shared-import-boundary')?.state
        ).toBe('executed');
        expect(await stderr).toContain('SIGTERM: stopping');
      } finally {
        child.kill('SIGKILL');
        await child.exited;
        await stderr;
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  );
});
