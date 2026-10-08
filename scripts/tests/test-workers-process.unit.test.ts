/**
 * The runner against real child processes: a stand-in for `bun test`
 * (support/fake-bun-test.ts) started through the same plan, pipes and signals
 * the lane uses. The verdict rules are in test-workers.unit.test.ts; this proves
 * the processes end up in them.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseJunitXml } from '../lib/junit-report';
import { pumpLines, startWorkerProcess, workerEnvironment } from '../lib/test-worker-process';
import { runWorkerLane, type WorkerLaneSpec } from '../lib/test-workers';
import { fixtureChildEnvironment } from './support/child-supervision';
import { FAKE_BUN_TEST, FAKE_CASES_PER_FILE } from './support/fake-bun-test';
import { fakeLane } from './support/test-worker-fakes';

const TEST_DIR = 'tests/unit';
const FILES = fakeLane(8, 1);
const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'mangostudio-worker-process-'));
  workspaces.push(root);
  for (const file of FILES) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), '');
  }
  const spec: WorkerLaneSpec = {
    id: 'api-unit',
    cwd: root,
    command: ['bun', 'test', '--timeout', '15000', '--parallel=1', TEST_DIR],
    testDir: TEST_DIR,
    launcher: [process.execPath, FAKE_BUN_TEST],
    settle: false,
  };
  return { root, spec, mergedPath: join(root, 'out', 'api-unit.xml'), scratch: join(root, 'tmp') };
}

/** Runs the lane for real, with `modes` deciding how each fake worker ends. */
async function runLane(
  count: number,
  modes: Record<number, string>,
  options: {
    signal?: AbortSignal;
    pidDir?: string;
    drainGraceMs?: number;
    settle?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {}
) {
  const { spec: base, mergedPath, scratch } = workspace();
  const spec = {
    ...base,
    id: options.settle ? 'api-integration' : base.id,
    settle: options.settle ?? false,
  };
  mkdirSync(scratch);
  const env = fixtureChildEnvironment({
    ...(options.env ?? process.env),
    MANGOSTUDIO_FAKE_WORKER_MODES: JSON.stringify(modes),
    MANGOSTUDIO_FAKE_PID_DIR: options.pidDir ?? scratch,
  });
  const lines: string[] = [];
  const sinks = {
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  };
  const result = await runWorkerLane({
    spec,
    count,
    mergedPath,
    scratchRoot: scratch,
    signal: options.signal,
    killAfterMs: 2_000,
    start: (plan) =>
      startWorkerProcess(
        plan,
        `[${spec.id} ${plan.index}/${plan.count}] `,
        sinks,
        options.drainGraceMs,
        env
      ),
  });
  return { ...result, lines, mergedPath, scratch };
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('four real worker processes', () => {
  it('discards an ambient runtime home before starting workers', async () => {
    const { verdict, lines } = await runLane(2, {}, {
      env: { ...process.env, MANGO_HOME: '/ambient/runtime-home' },
    });
    expect(verdict.failures).toEqual([]);
    expect(lines).toContain('[api-unit 1/2] mango-home=<unset>');
    expect(lines).toContain('[api-unit 2/2] mango-home=<unset>');
  });

  it('pass, and their merged report holds every case', async () => {
    const { verdict, mergedPath } = await runLane(4, {});
    expect(verdict.failures).toEqual([]);
    expect(verdict.totals.cases).toBe(FILES.length * FAKE_CASES_PER_FILE);
    const merged = parseJunitXml(readFileSync(mergedPath, 'utf8'));
    expect(merged.tests, `expected merged cases: ${FILES.length * FAKE_CASES_PER_FILE}`).toBe(
      FILES.length * FAKE_CASES_PER_FILE
    );
    expect(verdict.workers.map((worker) => worker.files)).toEqual([2, 2, 2, 2]);
  });

  it('keep the output of each worker on whole lines under its own prefix', async () => {
    const { lines } = await runLane(2, {});
    expect(lines.filter((line) => line.startsWith('[api-unit 1/2] '))).toContain(
      '[api-unit 1/2] fake worker 1/2 starting (pass)'
    );
    expect(lines).toContain('[api-unit 2/2] fake worker 2/2 stderr');
  });

  it('fail the lane when one exits non-zero', async () => {
    const { verdict } = await runLane(4, { 3: 'exit1' });
    expect(verdict.failures).toEqual([
      'api-unit worker 3/4 failed | expected: exit code 0 | received: 1',
    ]);
  });

  // A POSIX signal: Windows has no SIGKILL to be ended by.
  it.skipIf(process.platform === 'win32')(
    'fail the lane when one is killed, and write no merged report',
    async () => {
      const { verdict, mergedPath } = await runLane(4, { 2: 'sigkill' });
      expect(verdict.failures[0]).toContain('api-unit worker 2/4 was killed by SIGKILL');
      expect(await Bun.file(mergedPath).exists()).toBe(false);
    }
  );

  it('fail the lane when one leaves no report', async () => {
    const { verdict } = await runLane(4, { 4: 'no-report' });
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain('api-unit worker 4/4 wrote no report');
  });

  it('leave no scratch directory behind, pass or fail', async () => {
    const passed = await runLane(2, {});
    const failed = await runLane(2, { 1: 'exit1' });
    expect(readdirSync(passed.scratch)).toEqual([]);
    expect(readdirSync(failed.scratch)).toEqual([]);
  });
});

const readPid = (dir: string, name: string): number =>
  Number(readFileSync(join(dir, name), 'utf8'));

// Settlement is POSIX: Windows has no group to lead (the runner says so there).
describe.skipIf(process.platform === 'win32')('workers that must settle', () => {
  it('signals the whole group on cancellation without relying on settlement to reap a child', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'mangostudio-worker-pids-'));
    workspaces.push(pidDir);
    const controller = new AbortController();
    const running = runLane(
      2,
      { 1: 'hang-tree', 2: 'hang-tree' },
      {
        settle: true,
        signal: controller.signal,
        pidDir,
      }
    );
    const up = await until(() => readdirSync(pidDir).length === 4, 10_000);
    const pids = readdirSync(pidDir).map((name) => readPid(pidDir, name));
    try {
      expect(up, 'expected two workers and two children running before cancellation').toBe(true);
      controller.abort();
      const { verdict } = await running;
      expect(verdict.failures).toHaveLength(2);
      expect(verdict.failures.every((failure) => failure.includes('was cancelled'))).toBe(true);
      expect(pids.filter(isAlive), 'expected no live descendants after cancellation').toEqual([]);
    } finally {
      controller.abort();
      for (const pid of pids) {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('pass, in a group of their own, when nothing outlives them', async () => {
    const { verdict } = await runLane(3, {}, { settle: true });
    expect(verdict.failures).toEqual([]);
    expect(verdict.workers.map((worker) => worker.ended)).toEqual(['exit 0', 'exit 0', 'exit 0']);
  });

  it('pass when a child is still shutting down as the worker exits', async () => {
    const { verdict } = await runLane(2, { 1: 'tidy' }, { settle: true });
    expect(verdict.failures).toEqual([]);
  });

  it('fail the lane naming the leaked child’s pid and command, and kill it', async () => {
    const { verdict, scratch } = await runLane(4, { 2: 'leak' }, { settle: true });
    const leaked = readPid(scratch, 'leak-2.pid');
    try {
      expect(verdict.failures).toHaveLength(1);
      expect(verdict.failures[0]).toContain(
        'api-integration worker 2/4 left processes behind | expected live descendants: 0 | received: 1'
      );
      expect(verdict.failures[0]).toContain(`pid ${leaked}: `);
      expect(verdict.failures[0]).toContain('setInterval');
      expect(verdict.workers[1]?.ended).toBe('exit 0, left 1 running');
      const stillAlive = await until(() => !isAlive(leaked), 3_000);
      expect(
        stillAlive,
        `expected the lane to kill the leaked process ${leaked} | received: still running`
      ).toBe(true);
    } finally {
      if (isAlive(leaked)) process.kill(leaked, 'SIGKILL');
    }
  });

  // On Linux the environment token finds a descendant that started a session of its own.
  it.skipIf(process.platform !== 'linux')(
    'find a leaked child that left the group for a session of its own',
    async () => {
      const { verdict, scratch } = await runLane(2, { 1: 'leak-session' }, { settle: true });
      const leaked = readPid(scratch, 'leak-session-1.pid');
      try {
        expect(verdict.failures).toHaveLength(1);
        expect(verdict.failures[0]).toContain('api-integration worker 1/2 left processes behind');
        expect(verdict.failures[0]).toContain(`pid ${leaked}: `);
        const reaped = await until(() => !isAlive(leaked), 3_000);
        expect(
          reaped,
          `expected the lane to kill detached child ${leaked} before test cleanup | received: still running`
        ).toBe(true);
      } finally {
        if (isAlive(leaked)) process.kill(leaked, 'SIGKILL');
      }
    }
  );

  it('are not checked when the lane does not ask for it', async () => {
    const { verdict, scratch } = await runLane(2, { 1: 'leak' }, { settle: false });
    const leaked = readPid(scratch, 'leak-1.pid');
    try {
      expect(verdict.failures).toEqual([]);
    } finally {
      if (isAlive(leaked)) process.kill(leaked, 'SIGKILL');
    }
  });
});

async function until(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await Bun.sleep(25);
  }
  return ready();
}

describe('a worker that leaks a process holding its pipes', () => {
  it('does not hold the lane open past the drain grace, and still passes', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'mangostudio-worker-pids-'));
    workspaces.push(pidDir);
    const began = Date.now();

    const { verdict } = await runLane(
      2,
      { 1: 'grandchild' },
      {
        pidDir,
        drainGraceMs: 300,
        env: fixtureChildEnvironment(),
      }
    );
    const elapsed = Date.now() - began;

    const leaked = Number(readFileSync(join(pidDir, 'grandchild-1.pid'), 'utf8'));
    try {
      expect(verdict.failures).toEqual([]);
      if (process.platform !== 'win32') {
        expect(isAlive(leaked), 'expected the named orphan fixture to keep the pipes open').toBe(
          true
        );
        expect(
          elapsed,
          'expected the inherited pipes to require the drain grace'
        ).toBeGreaterThanOrEqual(300);
      }
      expect(
        elapsed,
        `expected the lane to end soon after the drain grace | received ${elapsed} ms with a leaked process holding the pipes`
      ).toBeLessThan(10_000);
    } finally {
      // Best effort: Windows ends a worker's children with the worker, leaving nothing to kill.
      try {
        process.kill(leaked, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
});

describe('cancelling real worker processes', () => {
  it('ends every worker and fails the lane naming each', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'mangostudio-worker-pids-'));
    workspaces.push(pidDir);
    const controller = new AbortController();
    const running = runLane(
      3,
      { 1: 'hang', 2: 'hang', 3: 'hang' },
      { signal: controller.signal, pidDir }
    );

    // Cancel only once every worker is up, or a late one would never be signalled.
    const deadline = Date.now() + 20_000;
    while (readdirSync(pidDir).length < 3 && Date.now() < deadline) await Bun.sleep(25);
    expect(readdirSync(pidDir).sort(), 'expected all 3 workers running before cancelling').toEqual([
      'worker-1.pid',
      'worker-2.pid',
      'worker-3.pid',
    ]);
    const pids = readdirSync(pidDir).map((name) =>
      Number(readFileSync(join(pidDir, name), 'utf8'))
    );
    controller.abort();
    const { verdict } = await running;

    expect(verdict.failures.filter((failure) => failure.includes('was cancelled'))).toHaveLength(3);
    expect(verdict.failures[0]).toContain('api-unit worker 1/3 was cancelled');
    const alive = pids.filter(isAlive);
    expect(alive, `expected live workers: 0 | received: ${alive.length} (pids ${alive})`).toEqual(
      []
    );
  });
});

describe('pumpLines', () => {
  const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

  it('delivers whole lines however the chunks fall, with CRLF trimmed', async () => {
    const lines: string[] = [];
    await pumpLines(streamOf('one\ntw', 'o\r\nthr', 'ee\n'), (line) => lines.push(line));
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('delivers a last line that has no newline', async () => {
    const lines: string[] = [];
    await pumpLines(streamOf('done\nlast'), (line) => lines.push(line));
    expect(lines).toEqual(['done', 'last']);
  });

  it('stops reading a stream nobody closes once told to, and keeps the last partial line', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first\npartial'));
        // never closed: a leaked process still holds the pipe
      },
    });
    const stop = new AbortController();
    const lines: string[] = [];

    const pumping = pumpLines(stream, (line) => lines.push(line), stop.signal);
    await Bun.sleep(50);
    expect(lines).toEqual(['first']);
    stop.abort();
    await pumping;

    expect(lines).toEqual(['first', 'partial']);
  });

  it('keeps a character split across chunks whole', async () => {
    const bytes = new TextEncoder().encode('é\n');
    const lines: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      },
    });
    await pumpLines(stream, (line) => lines.push(line));
    expect(lines).toEqual(['é']);
  });
});

describe('workerEnvironment', () => {
  it('drops MANGO_HOME, which would give every worker one runtime home', () => {
    const env = workerEnvironment(
      { MANGO_HOME: '/home/me/.mango', PATH: '/bin', HOME: '/home/me' },
      { env: {} }
    );
    expect(env, 'expected MANGO_HOME absent from a worker’s environment').toEqual({
      PATH: '/bin',
      HOME: '/home/me',
    });
  });

  it('adds the worker’s own variables over the inherited ones', () => {
    const env = workerEnvironment({ A: '1', B: '2' }, { env: { B: 'own', C: '3' } });
    expect(env).toEqual({ A: '1', B: 'own', C: '3' });
  });

  it('omits variables that are unset', () => {
    expect(workerEnvironment({ A: undefined, B: '2' }, { env: {} })).toEqual({ B: '2' });
  });
});
