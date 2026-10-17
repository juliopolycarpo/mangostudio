import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureChildEnvironment } from '../../tests/support/child-supervision';
import {
  ECHO_STDERR,
  ECHO_STDOUT,
  forceKill,
  forceKillGroup,
  isAlive,
  readGrandchildPid,
  readReadyPids,
  SIGNALS_LOG,
  waitFor,
} from '../../tests/support/process-tree';
import { captureFixtureCommand } from '../testing/capture-process';
import { runCapture } from './support';

const IS_WINDOWS = process.platform === 'win32';
// Existing process fixture readiness + supervisor grace/kill + init settling.
const PROCESS_TEST_TIMEOUT_MS = 20_000;
let dir = '';
const runners: ReturnType<typeof Bun.spawn>[] = [];
const childDirs: string[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-capture-')));
});

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    forceKillGroup(runner.pid);
    forceKill(runner.pid);
    await runner.exited;
  }
  for (const path of childDirs.splice(0)) {
    const pids = readReadyPids(path);
    if (pids) {
      forceKillGroup(pids.child);
      forceKill(pids.child);
      forceKill(pids.grandchild);
    }
    const grandchild = readGrandchildPid(path);
    if (grandchild) forceKill(grandchild);
  }
  rmSync(dir, { recursive: true, force: true });
});

function start(mode: string, width = 1, childStop = 'linger:300', grandchildStop = 'linger:300') {
  const env = fixtureChildEnvironment();
  // The fixture is the root under test; an ancestor must not clean up for it.
  env.MANGO_RUNNER_GROUP = '';
  env.QA_CAPTURE_FIXTURE_MARKER = 'inherited';
  for (let index = 0; index < width; index++) {
    const path = join(dir, String(index));
    mkdirSync(path);
    childDirs.push(path);
  }
  const runner = Bun.spawn(
    captureFixtureCommand(mode, dir, String(width), childStop, grandchildStop),
    { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: !IS_WINDOWS }
  );
  runners.push(runner);
  return runner;
}

async function ready(paths = childDirs): Promise<number[]> {
  const up = await waitFor(() => paths.every((path) => readReadyPids(path)), 10_000);
  expect(up, 'expected every captured child and grandchild ready').toBe(true);
  return paths.flatMap((path) => {
    const pids = readReadyPids(path);
    if (!pids) throw new Error(`expected captured process readiness at ${path}`);
    return [pids.child, pids.grandchild];
  });
}

async function expectGone(pids: number[]) {
  await waitFor(() => pids.every((pid) => !isAlive(pid)), 1_000);
  expect(pids.filter(isAlive), 'expected no surviving captured children or descendants').toEqual(
    []
  );
}

describe('QA captured subprocess ownership', () => {
  test('retains stdout, stderr and a successful exit without printing a command', async () => {
    const runner = start('echo');
    expect(await runner.exited).toBe(0);
    expect(JSON.parse(await new Response(runner.stdout).text())).toEqual({
      stdout: `${ECHO_STDOUT}\n`,
      stderr: `${ECHO_STDERR}\n`,
      exitCode: 0,
    });
    expect(await new Response(runner.stderr).text()).toBe('');
  });

  test('retains a nonzero tool exit as a result', async () => {
    const runner = start('exit', 7);
    expect(await runner.exited).toBe(0);
    expect(JSON.parse(await new Response(runner.stdout).text())).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 7,
    });
  });

  test('retains the working directory and inherited environment', async () => {
    const runner = start('inspect');
    expect(await runner.exited).toBe(0);
    const result = JSON.parse(await new Response(runner.stdout).text());
    expect(JSON.parse(result.stdout)).toEqual({ cwd: dir, marker: 'inherited' });
    expect(result.exitCode).toBe(0);
  });

  test('rejects a spawn failure rather than returning a successful result', async () => {
    await expect(runCapture(['qa-capture-no-such-command'])).rejects.toThrow();
  });

  for (const width of [1, 2]) {
    test(
      `SIGTERM stops the ${width === 1 ? 'serial' : 'concurrent'} capture tree`,
      async () => {
        const runner = start('tree', width);
        const pids = await ready();
        runner.kill('SIGTERM');
        const code = await runner.exited;
        await expectGone(pids);
        if (!IS_WINDOWS) expect(code).toBe(143);
        expect(await new Response(runner.stdout).text()).toBe('');
      },
      PROCESS_TEST_TIMEOUT_MS
    );
  }

  test.skipIf(IS_WINDOWS)(
    'an external timeout stops a resistant descendant before returning',
    async () => {
      const runner = start('tree', 1, 'linger:0', 'ignore');
      const pids = await ready();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        runner.kill('SIGTERM');
      }, 100);
      try {
        expect(await runner.exited).toBe(143);
        expect(timedOut).toBe(true);
        await expectGone(pids);
        expect(await new Response(runner.stdout).text()).toBe('');
      } finally {
        clearTimeout(timer);
      }
    },
    PROCESS_TEST_TIMEOUT_MS
  );

  test.skipIf(IS_WINDOWS)(
    'owns descendants holding captured pipes after their leader exits',
    async () => {
      const runner = start('pipes');
      childDirs.push(dir);
      const [leader, grandchild] = await ready([dir]);
      if (leader === undefined || grandchild === undefined) {
        throw new Error('expected ready leader and pipe-holding grandchild');
      }
      expect(await waitFor(() => !isAlive(leader), 10_000)).toBe(true);
      runner.kill('SIGTERM');
      expect(await runner.exited).toBe(143);
      await expectGone([grandchild]);
    },
    PROCESS_TEST_TIMEOUT_MS
  );

  test.skipIf(IS_WINDOWS)(
    'a nested capture keeps one SIGINT delivery under its owning runner',
    async () => {
      const runner = start('nested');
      const pids = await ready();
      runner.kill('SIGINT');
      expect(await runner.exited).toBe(130);
      await expectGone(pids);
      expect(
        readFileSync(join(dir, '0', SIGNALS_LOG), 'utf8')
          .trim()
          .split('\n')
          .sort()
      ).toEqual(['child SIGINT', 'grandchild SIGINT']);
    },
    PROCESS_TEST_TIMEOUT_MS
  );
});
