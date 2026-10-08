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
import { pumpLines, startWorkerProcess } from '../lib/test-worker-process';
import { runWorkerLane, type WorkerLaneSpec } from '../lib/test-workers';
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
  };
  return { root, spec, mergedPath: join(root, 'out', 'api-unit.xml'), scratch: join(root, 'tmp') };
}

/** Runs the lane for real, with `modes` deciding how each fake worker ends. */
async function runLane(
  count: number,
  modes: Record<number, string>,
  options: { signal?: AbortSignal; pidDir?: string; drainGraceMs?: number } = {}
) {
  const { spec, mergedPath, scratch } = workspace();
  mkdirSync(scratch);
  process.env.MANGOSTUDIO_FAKE_WORKER_MODES = JSON.stringify(modes);
  process.env.MANGOSTUDIO_FAKE_PID_DIR = options.pidDir ?? scratch;
  const lines: string[] = [];
  const sinks = {
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  };
  try {
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
          `[api-unit ${plan.index}/${plan.count}] `,
          sinks,
          options.drainGraceMs
        ),
    });
    return { ...result, lines, mergedPath, scratch };
  } finally {
    Reflect.deleteProperty(process.env, 'MANGOSTUDIO_FAKE_WORKER_MODES');
    Reflect.deleteProperty(process.env, 'MANGOSTUDIO_FAKE_PID_DIR');
  }
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

describe('a worker that leaks a process holding its pipes', () => {
  it('does not hold the lane open past the drain grace, and still passes', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'mangostudio-worker-pids-'));
    workspaces.push(pidDir);
    const began = Date.now();

    const { verdict } = await runLane(2, { 1: 'grandchild' }, { pidDir, drainGraceMs: 300 });
    const elapsed = Date.now() - began;

    const leaked = Number(readFileSync(join(pidDir, 'grandchild-1.pid'), 'utf8'));
    try {
      expect(verdict.failures).toEqual([]);
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
