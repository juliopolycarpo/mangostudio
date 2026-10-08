import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseJunitXml } from '../lib/junit-report';
import { WORKER_TOKEN_ENV } from '../lib/test-worker-settle';
import {
  describeCaseDifference,
  discoverTestFiles,
  formatLaneSummary,
  judgeWorkers,
  MAX_WORKERS,
  mergeReports,
  planWorkers,
  resolveWorkerCount,
  runWorkerLane,
  runWorkers,
  type StartWorker,
  splitLaneCommand,
  WORKERS_ENV,
  type WorkerLaneSpec,
} from '../lib/test-workers';
import {
  crashingWorker,
  FakeReportDisk,
  type FakeTestFile,
  failingWorker,
  fakeLane,
  HangingWorker,
  healthyWorker,
  killedWorker,
  reportOf,
  shardOf,
  silentWorker,
  unstartableWorker,
  withLeftovers,
  withUnreadableProcessTable,
  withWorker,
  writingWorker,
} from './support/test-worker-fakes';

const TEST_DIR = 'tests/unit';
const noKill = (): void => undefined;
const SERIAL_COMMAND = ['bun', 'test', '--timeout', '15000', '--parallel=1', TEST_DIR];
const SPEC: WorkerLaneSpec = {
  id: 'api-unit',
  cwd: '/work/apps/api',
  command: SERIAL_COMMAND,
  testDir: TEST_DIR,
  launcher: ['/bin/bun', '/work/scripts/with-test-home.ts'],
  settle: false,
};

/** Runs `count` fake workers over `lane` and judges them as the runner does. */
async function judgeFakeLane(
  lane: readonly FakeTestFile[],
  count: number,
  start: StartWorker,
  disk: FakeReportDisk,
  census: readonly string[] | null = lane.map((file) => file.path)
) {
  const plans = planWorkers(SPEC, count, '/reports/run-1');
  const runs = await runWorkers(plans, start);
  return judgeWorkers({ runs, readReport: disk.read, census, testDir: TEST_DIR });
}

describe('resolveWorkerCount', () => {
  it('defaults to six workers on a wide machine', () => {
    expect(resolveWorkerCount({}, 34, 'linux')).toBe(6);
    expect(resolveWorkerCount({}, 12, 'darwin')).toBe(6);
  });

  it('never takes more than half the cores, and never fewer than one', () => {
    expect(resolveWorkerCount({}, 10, 'linux')).toBe(5);
    expect(resolveWorkerCount({}, 8, 'linux')).toBe(4);
    expect(resolveWorkerCount({}, 4, 'linux')).toBe(2);
    expect(resolveWorkerCount({}, 2, 'linux')).toBe(1);
    expect(resolveWorkerCount({}, 1, 'linux')).toBe(1);
  });

  it('honours the override, even above half the cores', () => {
    expect(resolveWorkerCount({ [WORKERS_ENV]: '2' }, 34, 'linux')).toBe(2);
    expect(resolveWorkerCount({ [WORKERS_ENV]: ` ${MAX_WORKERS} ` }, 4, 'linux')).toBe(MAX_WORKERS);
  });

  it('treats an empty override as unset', () => {
    expect(resolveWorkerCount({ [WORKERS_ENV]: '' }, 34, 'linux')).toBe(6);
  });

  // Windows keeps the serial lane: the loopback test resets its connection under
  // concurrent workers there and the cause is not established. Pinned so lifting
  // it is a deliberate act, with the reason in front of whoever does.
  it('defaults to one worker on Windows, whatever the core count', () => {
    for (const cpus of [2, 8, 36, 128]) {
      expect(
        resolveWorkerCount({}, cpus, 'win32'),
        `expected the default worker count on win32 with ${cpus} cpus: 1`
      ).toBe(1);
    }
    expect(resolveWorkerCount({ [WORKERS_ENV]: '' }, 36, 'win32')).toBe(1);
  });

  it('takes the lane’s own default when it names one, still capped by the cores and still one on Windows', () => {
    expect(resolveWorkerCount({}, 34, 'linux', 4)).toBe(4);
    expect(resolveWorkerCount({}, 6, 'linux', 4)).toBe(3);
    expect(resolveWorkerCount({}, 34, 'win32', 4)).toBe(1);
    expect(resolveWorkerCount({ [WORKERS_ENV]: '8' }, 34, 'linux', 4)).toBe(8);
  });

  it('lets an explicit width win on Windows, and validates it as anywhere', () => {
    expect(resolveWorkerCount({ [WORKERS_ENV]: '6' }, 36, 'win32')).toBe(6);
    expect(resolveWorkerCount({ [WORKERS_ENV]: String(MAX_WORKERS) }, 4, 'win32')).toBe(
      MAX_WORKERS
    );
    expect(() => resolveWorkerCount({ [WORKERS_ENV]: '9' }, 36, 'win32')).toThrow(
      `expected ${WORKERS_ENV}: an integer from 1 to ${MAX_WORKERS} | received: "9"`
    );
  });

  it.each(['0', '9', '-1', '2.5', 'four', '1e1'])(
    'rejects %p with the value and the accepted range',
    (value) => {
      expect(() => resolveWorkerCount({ [WORKERS_ENV]: value }, 34, 'linux')).toThrow(
        `expected ${WORKERS_ENV}: an integer from 1 to ${MAX_WORKERS} | received: ${JSON.stringify(value)}`
      );
    }
  );
});

describe('splitLaneCommand', () => {
  it('finds nothing appended to the lane command', () => {
    expect(splitLaneCommand(SERIAL_COMMAND, TEST_DIR).extra).toEqual([]);
  });

  it('separates what `bun run test --changed` appends', () => {
    const { lane, extra } = splitLaneCommand([...SERIAL_COMMAND, '--changed=abc123'], TEST_DIR);
    expect(extra).toEqual(['--changed=abc123']);
    expect(lane).toEqual(SERIAL_COMMAND);
  });

  it('rejects a command that is not `bun test ... <dir>`', () => {
    expect(() => splitLaneCommand(['bun', 'test', '--timeout', '15000'], TEST_DIR)).toThrow(
      `expected a command like "bun test <flags> ${TEST_DIR}" | received: "bun test --timeout 15000"`
    );
    expect(() => splitLaneCommand(['node', 'test', TEST_DIR], TEST_DIR)).toThrow(
      'expected a command like'
    );
  });
});

describe('planWorkers', () => {
  const plans = planWorkers(SPEC, 4, '/reports/run-1');

  it('gives every worker its own shard of one count', () => {
    expect(plans.map((plan) => plan.argv.find((arg) => arg.startsWith('--shard=')))).toEqual([
      '--shard=1/4',
      '--shard=2/4',
      '--shard=3/4',
      '--shard=4/4',
    ]);
  });

  it('gives every worker its own report path, all inside the run directory', () => {
    const paths = plans.map((plan) => plan.reportPath);
    expect(new Set(paths).size).toBe(4);
    for (const path of paths) {
      expect(
        path.startsWith(join('/reports', 'run-1')),
        `report outside the run directory: ${path}`
      ).toBe(true);
    }
    for (const plan of plans) {
      expect(plan.argv).toContain(`--reporter-outfile=${plan.reportPath}`);
      expect(plan.argv).toContain('--reporter=junit');
    }
  });

  it('starts each `bun test` through the temporary-HOME launcher, flags before the directory', () => {
    const [first] = plans;
    expect(first?.argv.slice(0, 4)).toEqual([
      '/bin/bun',
      '/work/scripts/with-test-home.ts',
      'bun',
      'test',
    ]);
    expect(first?.argv.at(-1)).toBe(TEST_DIR);
    expect(first?.argv).toContain('--parallel=1');
    expect(first?.argv).toContain('--timeout');
  });

  it('leaves --no-orphans off a worker that must settle, and gives each its own token', () => {
    const settling = planWorkers({ ...SPEC, settle: true }, 4, '/reports/run-1');
    for (const plan of settling) {
      expect(
        plan.argv,
        `worker ${plan.index} must not run --no-orphans, which kills the evidence`
      ).not.toContain('--no-orphans');
      expect(plan.settle).toBe(true);
    }
    const tokens = settling.map((plan) => plan.env[WORKER_TOKEN_ENV]);
    expect(tokens.every((token) => typeof token === 'string' && token.length > 8)).toBe(true);
    expect(new Set(tokens).size).toBe(4);
    for (const plan of plans) {
      expect(plan.settle).toBe(false);
      expect(plan.env).toEqual({});
    }
  });

  it('starts every worker with --no-orphans so a killed launcher takes its bun test with it', () => {
    for (const plan of plans) {
      expect(
        plan.argv,
        `worker ${plan.index}/${plan.count} must die with its launcher | expected: --no-orphans in the bun test arguments | received: ${plan.argv.join(' ')}`
      ).toContain('--no-orphans');
    }
  });

  it('runs a single worker as the serial command, with no shard', () => {
    const [only] = planWorkers(SPEC, 1, '/reports/run-1');
    expect(only?.argv.some((arg) => arg.startsWith('--shard'))).toBe(false);
    expect(only?.argv.at(-1)).toBe(TEST_DIR);
  });

  it.each(['--shard=1/2', '--reporter=dots', '--reporter-outfile=x.xml', '--no-orphans'])(
    'refuses a lane command that already sets %p',
    (flag) => {
      expect(() =>
        planWorkers({ ...SPEC, command: ['bun', 'test', flag, TEST_DIR] }, 2, '/r')
      ).toThrow(`which the runner sets per worker | received: ${flag}`);
    }
  );
});

describe('the merged report equals the single-worker report', () => {
  const lane: FakeTestFile[] = [
    ...fakeLane(9, 3),
    { path: 'tests/unit/zz/skipped.test.ts', cases: ['not here'], outcome: 'skip' },
  ];
  const serial = parseJunitXml(reportOf(lane));

  it('holds the same cases and outcomes as one worker, for every width', async () => {
    for (const count of [1, 2, 3, 4, 8]) {
      const disk = new FakeReportDisk();
      const verdict = await judgeFakeLane(lane, count, healthyWorker(lane, disk), disk);
      expect(verdict.failures, `${count} workers failed`).toEqual([]);

      const merged = parseJunitXml(verdict.mergedXml as string);
      const difference = describeCaseDifference(serial.cases, merged.cases);
      expect(
        difference,
        `expected the merged cases of ${count} workers to equal the single-worker set | received: ${difference}`
      ).toBeNull();
      expect(merged.truncated, `merged report is incomplete at ${count} workers`).toBeNull();
      expect(merged.tests).toBe(serial.tests);
      expect(merged.skipped).toBe(serial.skipped);
    }
  });

  it('adds up the header counters and keeps the slowest time', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(lane, 4, healthyWorker(lane, disk), disk);
    const header = /<testsuites ([^>]*)>/.exec(verdict.mergedXml as string)?.[1] ?? '';
    expect(header).toContain(`tests="${serial.tests}"`);
    expect(header).toContain(`assertions="${serial.tests}"`);
    expect(header).toContain('skipped="1"');
    expect(header).toContain('time="1.5"');
    expect(header).toContain('name="bun test"');
  });

  it('names the first missing case when a worker loses one', async () => {
    const disk = new FakeReportDisk();
    const losing = (plan: Parameters<StartWorker>[0]) => {
      const files = shardOf(lane, plan).map((file, position) =>
        position === 0 && plan.index === 2 ? { ...file, cases: file.cases.slice(0, -1) } : file
      );
      return writingWorker(reportOf(files), disk)(plan);
    };
    const verdict = await judgeFakeLane(lane, 4, losing, disk, null);
    const merged = parseJunitXml(verdict.mergedXml as string);

    const difference = describeCaseDifference(serial.cases, merged.cases);
    expect(difference).toContain('expected 28 cases | received 27');
    expect(difference).toContain(
      'first missing: tests/unit/area-01/thing-1.test.ts||case 1.2|3 [passed]'
    );
    expect(difference).toContain('first extra: none');
  });

  it('names the first extra case when a worker repeats or invents one', async () => {
    const disk = new FakeReportDisk();
    const inventing = (plan: Parameters<StartWorker>[0]) => {
      const files = shardOf(lane, plan);
      const extraFile: FakeTestFile = { path: 'tests/unit/rogue.test.ts', cases: ['rogue'] };
      return writingWorker(reportOf(plan.index === 1 ? [...files, extraFile] : files), disk)(plan);
    };
    const verdict = await judgeFakeLane(lane, 4, inventing, disk, null);

    const difference = describeCaseDifference(
      serial.cases,
      parseJunitXml(verdict.mergedXml as string).cases
    );
    expect(difference).toContain('expected 28 cases | received 29');
    expect(difference).toContain('first missing: none');
    expect(difference).toContain('first extra: tests/unit/rogue.test.ts||rogue|1 [passed]');
  });

  it('tells a case that changed outcome from the same case', () => {
    const passed = parseJunitXml(
      reportOf([{ path: 'tests/unit/a.test.ts', cases: ['one'] }])
    ).cases;
    const failed = parseJunitXml(
      reportOf([{ path: 'tests/unit/a.test.ts', cases: ['one'], outcome: 'fail' }])
    ).cases;
    const difference = describeCaseDifference(passed, failed);
    expect(difference).toContain('first missing: tests/unit/a.test.ts||one|1 [passed]');
    expect(difference).toContain('first extra: tests/unit/a.test.ts||one|1 [failed]');
  });

  it('counts a case that ran twice as two', () => {
    const once = parseJunitXml(reportOf([{ path: 'tests/unit/a.test.ts', cases: ['one'] }])).cases;
    expect(describeCaseDifference(once, [...once, ...once])).toContain('first extra:');
  });
});

describe('a worker that does not finish cleanly fails the lane, naming its index', () => {
  const lane = fakeLane(8, 2);

  it('fails for a worker that exits non-zero, though it wrote its report', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      4,
      withWorker(2, failingWorker(lane, disk), healthyWorker(lane, disk)),
      disk
    );
    expect(verdict.failures).toEqual([
      'api-unit worker 2/4 failed | expected: exit code 0 | received: 1',
    ]);
    // The report is whole, so the lane keeps it: it lists exactly what failed.
    expect(verdict.mergedXml).not.toBeNull();
    expect(verdict.totals.failed).toBe(4);
  });

  it('fails for a worker that crashed before it wrote a report', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      4,
      withWorker(3, crashingWorker(2), healthyWorker(lane, disk)),
      disk
    );
    expect(verdict.failures[0]).toBe(
      'api-unit worker 3/4 failed | expected: exit code 0 | received: 2'
    );
    expect(verdict.failures[1]).toContain('api-unit worker 3/4 wrote no report');
    expect(verdict.mergedXml).toBeNull();
  });

  it('fails for a worker that exits 0 and writes no report', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      4,
      withWorker(4, silentWorker, healthyWorker(lane, disk)),
      disk
    );
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain('api-unit worker 4/4 wrote no report');
    expect(verdict.failures[0]).toContain(
      `expected: a JUnit report at ${join('/reports/run-1', 'worker-4-of-4.xml')}`
    );
    expect(verdict.failures[0]).toContain('received: no file');
    expect(verdict.mergedXml).toBeNull();
  });

  it('fails for a worker that was killed by a signal', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      4,
      withWorker(1, killedWorker('SIGKILL'), healthyWorker(lane, disk)),
      disk
    );
    expect(verdict.failures[0]).toBe(
      'api-unit worker 1/4 was killed by SIGKILL | expected: exit code 0 | received: signal SIGKILL'
    );
    expect(verdict.workers[0]?.ended).toBe('killed by SIGKILL');
    expect(verdict.mergedXml).toBeNull();
  });

  it('reads the launcher’s 128-plus-signal exit code as a kill', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      2,
      withWorker(2, crashingWorker(137), healthyWorker(lane, disk)),
      disk
    );
    expect(verdict.failures[0]).toBe(
      'api-unit worker 2/2 failed | expected: exit code 0 | received: 137 (128 + signal 9)'
    );
  });

  it('fails for a worker whose report was cut off', async () => {
    const disk = new FakeReportDisk();
    const cutOff = reportOf(lane).slice(0, 400);
    const verdict = await judgeFakeLane(
      lane,
      2,
      withWorker(1, writingWorker(cutOff, disk), healthyWorker(lane, disk)),
      disk,
      null
    );
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain('api-unit worker 1/2 wrote an incomplete report');
    expect(verdict.failures[0]).toContain('expected: a whole JUnit document');
    expect(verdict.mergedXml).toBeNull();
  });

  it('fails for a worker that could not be started', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      4,
      withWorker(2, unstartableWorker('spawn bun ENOENT'), healthyWorker(lane, disk)),
      disk
    );
    expect(verdict.failures).toEqual([
      'api-unit worker 2/4 did not start | expected: a running process | received: spawn bun ENOENT',
    ]);
    expect(verdict.mergedXml).toBeNull();
  });

  it('fails for a worker that exits 0 having run no case at all', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      2,
      withWorker(2, writingWorker(reportOf([]), disk), healthyWorker(lane, disk)),
      disk,
      null
    );
    expect(verdict.failures[0]).toBe(
      'api-unit worker 2/2 ran green but reported no cases | expected: at least 1 case | received: 0'
    );
  });

  it('reports every failing worker, not only the first', async () => {
    const disk = new FakeReportDisk();
    const start = withWorker(
      1,
      killedWorker('SIGKILL'),
      withWorker(3, crashingWorker(1), healthyWorker(lane, disk))
    );
    const verdict = await judgeFakeLane(lane, 4, start, disk);
    const named = verdict.failures.map((failure) => failure.split(' ').slice(0, 3).join(' '));
    expect(named).toContain('api-unit worker 1/4');
    expect(named).toContain('api-unit worker 3/4');
  });

  it('puts the expected and received value in every failure', async () => {
    const disk = new FakeReportDisk();
    const start = withWorker(
      1,
      killedWorker('SIGKILL'),
      withWorker(2, crashingWorker(1), withWorker(3, silentWorker, healthyWorker(lane, disk)))
    );
    const verdict = await judgeFakeLane(lane, 4, start, disk);
    for (const failure of verdict.failures) {
      expect(failure, `failure without expected/received: ${failure}`).toMatch(
        /\| expected: .+ \| received: .+/
      );
    }
  });
});

describe('a worker that leaves a process behind fails the lane', () => {
  const lane = fakeLane(8, 2);
  const leaked = [{ pid: 4242, command: 'sleep 600' }];

  it('names the worker, the count and the child’s pid and command', async () => {
    const disk = new FakeReportDisk();
    const leaking = (plan: Parameters<StartWorker>[0]) =>
      (plan.index === 2
        ? withLeftovers(healthyWorker(lane, disk), leaked)
        : healthyWorker(lane, disk))(plan);
    const verdict = await judgeFakeLane(lane, 4, leaking, disk);

    expect(verdict.failures).toEqual([
      'api-unit worker 2/4 left processes behind | expected live descendants: 0 | received: 1 (pid 4242: sleep 600)',
    ]);
    expect(verdict.workers[1]?.ended).toBe('exit 0, left 1 running');
    // The reports are whole and equal, so the lane keeps its merged report: the
    // failure is the leak, not the cases.
    expect(verdict.mergedXml).not.toBeNull();
  });

  it('lists the first five leftovers and counts the rest', async () => {
    const disk = new FakeReportDisk();
    const many = Array.from({ length: 7 }, (_, offset) => ({
      pid: 5000 + offset,
      command: `runtime ${offset}`,
    }));
    const verdict = await judgeFakeLane(
      lane,
      2,
      withLeftovers(healthyWorker(lane, disk), many),
      disk
    );
    expect(verdict.failures[0]).toContain('received: 7 (pid 5000: runtime 0;');
    expect(verdict.failures[0]).toContain('pid 5004: runtime 4; and 2 more)');
  });

  it('passes a worker that settled', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      4,
      withLeftovers(healthyWorker(lane, disk), []),
      disk
    );
    expect(verdict.failures).toEqual([]);
  });

  it('fails a worker that requests settlement without providing the guard', async () => {
    const disk = new FakeReportDisk();
    const plans = planWorkers({ ...SPEC, settle: true }, 1, '/reports/unchecked');
    const runs = await runWorkers(plans, writingWorker(reportOf(lane), disk));
    const verdict = judgeWorkers({ runs, readReport: disk.read, census: null, testDir: TEST_DIR });
    expect(verdict.failures).toEqual([
      'api-unit worker 1/1 could not be checked for leftover processes | expected: a readable process table | received: worker requested settlement but provided no guard',
    ]);
  });

  it('fails a worker whose process table could not be read, rather than passing it', async () => {
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      2,
      withUnreadableProcessTable(healthyWorker(lane, disk), 'ps: exit 1'),
      disk
    );
    expect(verdict.failures[0]).toBe(
      'api-unit worker 1/2 could not be checked for leftover processes | expected: a readable process table | received: ps: exit 1'
    );
  });
});

describe('cancelling the lane', () => {
  it('stops every running worker and fails the lane naming each', async () => {
    const hanging = [new HangingWorker(), new HangingWorker()];
    const start: StartWorker = (plan) => (hanging[plan.index - 1] as HangingWorker).start(plan);
    const controller = new AbortController();
    const plans = planWorkers(SPEC, 2, '/reports/run-1');

    const pending = runWorkers(plans, start, { signal: controller.signal });
    controller.abort();
    const runs = await pending;

    expect(hanging.map((worker) => worker.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
    expect(runs.every((run) => run.cancelled)).toBe(true);
    const verdict = judgeWorkers({
      runs,
      readReport: () => null,
      census: null,
      testDir: TEST_DIR,
    });
    expect(verdict.failures).toEqual([
      'api-unit worker 1/2 was cancelled | expected: to run to completion | received: cancelled',
      'api-unit worker 2/2 was cancelled | expected: to run to completion | received: cancelled',
    ]);
  });

  it('kills a worker that ignores SIGTERM', async () => {
    const stubborn = new HangingWorker(true);
    const controller = new AbortController();
    const plans = planWorkers(SPEC, 1, '/reports/run-1');

    const pending = runWorkers(plans, stubborn.start, {
      signal: controller.signal,
      killAfterMs: 5,
    });
    controller.abort();
    const [run] = await pending;

    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(run?.cancelled).toBe(true);
  });

  it('cancels workers started after the signal already fired', async () => {
    const hanging = new HangingWorker();
    const controller = new AbortController();
    controller.abort();
    const [run] = await runWorkers(planWorkers(SPEC, 1, '/r'), hanging.start, {
      signal: controller.signal,
    });
    expect(hanging.signals).toEqual(['SIGTERM']);
    expect(run?.cancelled).toBe(true);
  });

  it('does not signal a worker that finished before the cancellation', async () => {
    const kills: string[] = [];
    const finished: StartWorker = () => ({
      exited: Promise.resolve({ exitCode: 0, signal: null }),
      kill: (signal) => {
        kills.push(signal);
      },
    });
    const controller = new AbortController();
    const runs = await runWorkers(planWorkers(SPEC, 2, '/r'), finished, {
      signal: controller.signal,
    });
    controller.abort();
    expect(runs.some((run) => run.cancelled)).toBe(false);
    expect(kills, `expected signals to finished workers: none | received: ${kills}`).toEqual([]);
  });
});

describe('the files the reports name are the files the lane owns', () => {
  const lane = fakeLane(8, 2);

  it('fails when a worker drops a file nobody else ran', async () => {
    const disk = new FakeReportDisk();
    const dropping = (plan: Parameters<StartWorker>[0]) =>
      writingWorker(reportOf(shardOf(lane, plan).slice(plan.index === 3 ? 1 : 0)), disk)(plan);
    const verdict = await judgeFakeLane(lane, 4, dropping, disk);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toBe(
      `no worker reported tests/unit/area-02/thing-2.test.ts | expected: all 8 files under ${TEST_DIR} | received: 1 unreported`
    );
  });

  it('fails when two workers ran the same file', async () => {
    const disk = new FakeReportDisk();
    const doubling = (plan: Parameters<StartWorker>[0]) => {
      const files = shardOf(lane, plan);
      const borrowed = plan.index === 2 ? shardOf(lane, { index: 1, count: 4 }).slice(0, 1) : [];
      return writingWorker(reportOf([...files, ...borrowed]), disk)(plan);
    };
    const verdict = await judgeFakeLane(lane, 4, doubling, disk);
    expect(verdict.failures).toEqual([
      'tests/unit/area-00/thing-0.test.ts was reported by api-unit worker 1/4 and api-unit worker 2/4 | expected: one worker per file | received: 2',
    ]);
  });

  it('fails when a worker ran a file the lane does not own', async () => {
    const disk = new FakeReportDisk();
    const straying = (plan: Parameters<StartWorker>[0]) => {
      const rogue: FakeTestFile = { path: 'tests/integration/rogue.test.ts', cases: ['rogue'] };
      return writingWorker(
        reportOf(plan.index === 4 ? [...shardOf(lane, plan), rogue] : shardOf(lane, plan)),
        disk
      )(plan);
    };
    const verdict = await judgeFakeLane(lane, 4, straying, disk);
    expect(verdict.failures).toEqual([
      `api-unit worker 4/4 reported tests/integration/rogue.test.ts | expected: a file under ${TEST_DIR} | received: a file the lane does not own`,
    ]);
  });

  it('does not require every file when the run selected a subset', async () => {
    const disk = new FakeReportDisk();
    const subset = (plan: Parameters<StartWorker>[0]) =>
      writingWorker(reportOf(shardOf(lane, plan).slice(0, 1)), disk)(plan);
    const verdict = await judgeFakeLane(lane, 4, subset, disk, null);
    expect(verdict.failures).toEqual([]);
  });
});

describe('mergeReports', () => {
  it('refuses a document with no <testsuites> root', () => {
    expect(() => mergeReports(['<html/>'])).toThrow(
      'expected a JUnit document with a <testsuites> root | received: "<html/>"'
    );
  });

  it('refuses to merge nothing', () => {
    expect(() => mergeReports([])).toThrow('expected at least one report to merge | received: 0');
  });
});

describe('formatLaneSummary', () => {
  it('leads with the lane totals, then each worker, then each failure', async () => {
    const lane = fakeLane(4, 2);
    const disk = new FakeReportDisk();
    const verdict = await judgeFakeLane(
      lane,
      2,
      withWorker(2, crashingWorker(1), healthyWorker(lane, disk)),
      disk
    );
    const lines = formatLaneSummary('api-unit', verdict, 73_100);
    expect(lines[0]).toBe(
      'api-unit: 2 workers, 2 files, 4 cases (4 passed, 0 skipped, 0 failed) in 73.1s'
    );
    expect(lines[1]).toContain('api-unit worker 1/2: exit 0, 2 files, 4 cases');
    expect(lines[2]).toContain('api-unit worker 2/2: exit 1, 0 files, 0 cases');
    expect(lines.filter((line) => line.startsWith('FAILED '))).toHaveLength(2);
  });
});

describe('discoverTestFiles', () => {
  it('lists every file Bun would run, relative to the workspace and sorted', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mangostudio-discover-'));
    try {
      const present = [
        'tests/unit/b.test.ts',
        'tests/unit/a.test.ts',
        'tests/unit/deep/er/c.spec.tsx',
        'tests/unit/deep/d_test.js',
        'tests/unit/deep/e_spec.mts',
      ];
      const absent = [
        'tests/unit/support/helper.ts',
        'tests/unit/notes.md',
        'tests/integration/x.test.ts',
      ];
      for (const file of [...present, ...absent]) {
        mkdirSync(dirname(join(cwd, file)), { recursive: true });
        writeFileSync(join(cwd, file), '');
      }
      expect(discoverTestFiles(cwd, TEST_DIR)).toEqual([...present].sort());
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('runWorkerLane', () => {
  /** A workspace on disk with `lane`'s files, and a fake that writes each shard's report for real. */
  function workspaceOf(lane: readonly FakeTestFile[]) {
    const root = mkdtempSync(join(tmpdir(), 'mangostudio-lane-'));
    for (const file of lane) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), '');
    }
    const spec: WorkerLaneSpec = { ...SPEC, cwd: root };
    const writeShard =
      (source: readonly FakeTestFile[]): StartWorker =>
      (plan) => {
        writeFileSync(plan.reportPath, reportOf(shardOf(source, plan)));
        return { exited: Promise.resolve({ exitCode: 0, signal: null }), kill: noKill };
      };
    return { root, spec, writeShard, mergedPath: join(root, '.out', 'junit', 'api-unit.xml') };
  }

  it('writes one merged report with every case and removes its scratch directory', async () => {
    const lane = fakeLane(6, 3);
    const { root, spec, writeShard, mergedPath } = workspaceOf(lane);
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    try {
      const { verdict } = await runWorkerLane({
        spec,
        count: 3,
        start: writeShard(lane),
        mergedPath,
        scratchRoot: scratch,
      });
      expect(verdict.failures).toEqual([]);
      expect(parseJunitXml(readFileSync(mergedPath, 'utf8')).tests).toBe(18);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the previous lane report before it runs and writes none for a failed lane', async () => {
    const lane = fakeLane(4, 1);
    const { root, spec, writeShard, mergedPath } = workspaceOf(lane);
    mkdirSync(dirname(mergedPath), { recursive: true });
    writeFileSync(mergedPath, 'last run’s report');
    try {
      const failing = withWorker(2, killedWorker('SIGKILL'), writeShard(lane));
      const { verdict } = await runWorkerLane({ spec, count: 2, start: failing, mergedPath });
      expect(verdict.failures).toHaveLength(2);
      const left = Bun.file(mergedPath);
      expect(await left.exists(), `expected no report at ${mergedPath} after a failed lane`).toBe(
        false
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts only the files the lane owned when it started', async () => {
    const lane = fakeLane(4, 1);
    const { root, spec, writeShard, mergedPath } = workspaceOf(lane);
    try {
      // The workers report a file the workspace does not have: a stale or foreign report.
      const foreign = [...lane, { path: 'tests/unit/ghost.test.ts', cases: ['ghost'] }];
      const { verdict } = await runWorkerLane({
        spec,
        count: 2,
        start: writeShard(foreign),
        mergedPath,
      });
      expect(verdict.failures.join('\n')).toContain('tests/unit/ghost.test.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
