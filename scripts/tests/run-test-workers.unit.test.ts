/**
 * The runner's own decisions: what it exits with, when it splits and when it
 * does not, and what an interrupt does. The workers are named fakes; the lane is
 * the real `api-unit` one, so the file census is the real `tests/unit` tree.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { parseJunitXml } from '../lib/junit-report';
import { laneById, workerReportPath } from '../lib/test-lanes';
import {
  describeCaseDifference,
  discoverTestFiles,
  type StartWorker,
  WORKERS_ENV,
  type WorkerPlan,
} from '../lib/test-workers';
import { main, type RunnerDeps, systemDeps } from '../run-test-workers';
import {
  crashingWorker,
  diskWorker,
  type FakeTestFile,
  HangingWorker,
  killedWorker,
  reportOf,
  silentWorker,
  withLeftovers,
  withWorker,
} from './support/test-worker-fakes';

const LANE_COMMAND = ['bun', 'test', '--timeout', '15000', '--parallel=1', 'tests/unit'];
const ARGV = ['--lane=api-unit', '--', ...LANE_COMMAND];
const REAL_FILES: FakeTestFile[] = discoverTestFiles(
  join(ROOT_DIR, 'apps', 'api'),
  'tests/unit'
).map((path) => ({ path, cases: ['one', 'two'] }));

const INTEGRATION_ARGV = [
  '--lane=api-integration',
  '--',
  'bun',
  'test',
  '--timeout',
  '15000',
  'tests/integration',
];
const INTEGRATION_FILES: FakeTestFile[] = discoverTestFiles(
  join(ROOT_DIR, 'apps', 'api'),
  'tests/integration'
).map((path) => ({ path, cases: ['one'] }));

const scratch: string[] = [];
const RUNTIME_HOME_PROBE = [
  'bun',
  '-e',
  'process.exit(process.env.MANGO_HOME === undefined ? 0 : 27)',
];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Deps whose workers are `start`, with the merged report in a throwaway directory. */
function harness(start: StartWorker, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-runner-'));
  scratch.push(dir);
  const started: number[] = [];
  const serial: (readonly string[])[] = [];
  const lines: string[] = [];
  let interrupt: (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP') => void = () => undefined;
  const deps: RunnerDeps = {
    env,
    cpus: 34,
    platform: 'linux',
    mergedPath: join(dir, 'out', 'api-unit.xml'),
    start: (plan) => {
      started.push(plan.index);
      return start(plan);
    },
    runSerial: (command) => {
      serial.push(command);
      return Promise.resolve(7);
    },
    onInterrupt: (handler) => {
      interrupt = handler;
    },
    print: (line) => lines.push(line),
  };
  return {
    deps,
    started,
    serial,
    lines,
    mergedPath: deps.mergedPath as string,
    interrupt: (s: 'SIGINT' | 'SIGTERM' | 'SIGHUP') => interrupt(s),
  };
}

describe('run-test-workers', () => {
  it('discards an ambient runtime home on the selected-run fallback', async () => {
    const previous = process.env.MANGO_HOME;
    process.env.MANGO_HOME = '/ambient/runtime-home';
    try {
      expect(await systemDeps().runSerial(RUNTIME_HOME_PROBE)).toBe(0);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'MANGO_HOME');
      else process.env.MANGO_HOME = previous;
    }
  });

  it('has the real lane’s files to census', () => {
    expect(REAL_FILES.length).toBeGreaterThan(100);
  });

  it('exits 0 and writes the merged report when every worker passes', async () => {
    const run = harness(diskWorker(REAL_FILES), { [WORKERS_ENV]: '3' });
    expect(await main(ARGV, run.deps)).toBe(0);
    expect(run.started.sort()).toEqual([1, 2, 3]);
    const merged = parseJunitXml(readFileSync(run.mergedPath, 'utf8'));
    expect(merged.tests, `expected merged cases: ${REAL_FILES.length * 2}`).toBe(
      REAL_FILES.length * 2
    );
    expect(run.lines[0]).toContain(`api-unit: 3 workers, ${REAL_FILES.length} files`);
  });

  it('puts the merged report in the worker directory and leaves the coverage evidence alone', async () => {
    const run = harness(diskWorker(REAL_FILES), { [WORKERS_ENV]: '2' });
    const root = mkdtempSync(join(tmpdir(), 'mangostudio-runner-root-'));
    scratch.push(root);
    const lane = laneById('api-unit');
    const coveragePath = join(root, lane.junitPath);
    mkdirSync(join(coveragePath, '..'), { recursive: true });
    writeFileSync(coveragePath, 'the coverage lane’s own report');
    const deps: RunnerDeps = { ...run.deps, mergedPath: undefined, rootDir: root };

    expect(await main(ARGV, deps)).toBe(0);

    const written = join(root, workerReportPath(lane));
    expect(
      existsSync(written),
      `expected the merged report at ${written} | received: nothing there`
    ).toBe(true);
    expect(
      readFileSync(coveragePath, 'utf8'),
      `expected ${lane.junitPath} untouched by a plain run | received: it was rewritten`
    ).toBe('the coverage lane’s own report');
  });

  it('starts six workers on a wide machine when nothing overrides it', async () => {
    const run = harness(diskWorker(REAL_FILES));
    expect(await main(ARGV, run.deps)).toBe(0);
    expect(run.started.sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('runs one worker, unsharded, on Windows unless the width is set', async () => {
    const seen: string[][] = [];
    const run = harness((plan) => {
      seen.push([...plan.argv]);
      return diskWorker(REAL_FILES)(plan);
    });
    const windows: RunnerDeps = { ...run.deps, platform: 'win32' };

    expect(await main(ARGV, windows)).toBe(0);
    expect(run.started).toEqual([1]);
    expect(seen[0]?.some((arg) => arg.startsWith('--shard'))).toBe(false);

    const wide = harness(diskWorker(REAL_FILES), { [WORKERS_ENV]: '3' });
    expect(await main(ARGV, { ...wide.deps, platform: 'win32' })).toBe(0);
    expect(wide.started.sort()).toEqual([1, 2, 3]);
  });

  it('exits 1 and names the worker when one is killed', async () => {
    const run = harness(withWorker(2, killedWorker('SIGKILL'), diskWorker(REAL_FILES)), {
      [WORKERS_ENV]: '3',
    });
    expect(await main(ARGV, run.deps)).toBe(1);
    expect(run.lines.filter((line) => line.startsWith('FAILED '))[0]).toContain(
      'api-unit worker 2/3 was killed by SIGKILL'
    );
    expect(existsSync(run.mergedPath)).toBe(false);
  });

  it('exits 1 when a worker leaves no report', async () => {
    const run = harness(withWorker(1, silentWorker, diskWorker(REAL_FILES)), {
      [WORKERS_ENV]: '2',
    });
    expect(await main(ARGV, run.deps)).toBe(1);
    expect(run.lines.join('\n')).toContain('api-unit worker 1/2 wrote no report');
  });

  it('exits 1 when a worker exits non-zero', async () => {
    const run = harness(withWorker(2, crashingWorker(3), diskWorker(REAL_FILES)), {
      [WORKERS_ENV]: '2',
    });
    expect(await main(ARGV, run.deps)).toBe(1);
  });

  it('exits 1 when a file is run by no worker', async () => {
    const run = harness(diskWorker(REAL_FILES.slice(1)), { [WORKERS_ENV]: '2' });
    expect(await main(ARGV, run.deps)).toBe(1);
    expect(run.lines.join('\n')).toContain(`no worker reported ${REAL_FILES[0]?.path}`);
  });

  it('exits 130 for a SIGINT that arrives while the workers run, and 143 for SIGTERM', async () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const hanging = [new HangingWorker(), new HangingWorker()];
      const run = harness((plan) => (hanging[plan.index - 1] as HangingWorker).start(plan), {
        [WORKERS_ENV]: '2',
      });
      const running = main(ARGV, run.deps);
      while (run.started.length < 2) await Bun.sleep(5);
      run.interrupt(signal);
      expect(await running, `expected exit code after ${signal}: ${code}`).toBe(code);
      expect(hanging.map((worker) => worker.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
      expect(run.lines.filter((line) => line.includes('was cancelled'))).toHaveLength(2);
    }
  });

  it('runs a selected command as one process, as before, and drops the old merged report', async () => {
    const run = harness(diskWorker(REAL_FILES));
    mkdirSync(join(run.mergedPath, '..'), { recursive: true });
    writeFileSync(run.mergedPath, 'a previous run’s report');

    const code = await main([...ARGV, '--changed=abc123'], run.deps);

    expect(code, 'expected the serial runner’s exit code to be returned').toBe(7);
    expect(run.started, 'expected no worker for a selected run').toEqual([]);
    expect(run.serial).toEqual([[...LANE_COMMAND, '--changed=abc123']]);
    expect(existsSync(run.mergedPath)).toBe(false);
  });

  it('splits the integration lane the same way, and fails it when a worker leaks a process', async () => {
    const run = harness(diskWorker(INTEGRATION_FILES), { [WORKERS_ENV]: '4' });
    expect(await main(INTEGRATION_ARGV, run.deps)).toBe(0);
    expect(run.started.sort()).toEqual([1, 2, 3, 4]);
    expect(run.lines[0]).toContain(`api-integration: 4 workers, ${INTEGRATION_FILES.length} files`);

    const leaky = harness(
      withLeftovers(diskWorker(INTEGRATION_FILES), [
        { pid: 4242, command: 'mangostudio-runtime serve' },
      ]),
      { [WORKERS_ENV]: '2' }
    );
    expect(await main(INTEGRATION_ARGV, leaky.deps)).toBe(1);
    expect(leaky.lines.filter((line) => line.startsWith('FAILED '))[0]).toContain(
      'api-integration worker 1/2 left processes behind | expected live descendants: 0 | received: 1 (pid 4242: mangostudio-runtime serve)'
    );
  });

  it('defaults the integration lane to four workers and preserves every case and outcome', async () => {
    const files = INTEGRATION_FILES.map((file, index) => ({
      ...file,
      outcome: index % 7 === 0 ? ('skip' as const) : ('pass' as const),
    }));
    const run = harness(diskWorker(files));
    expect(await main(INTEGRATION_ARGV, run.deps)).toBe(0);
    expect(run.started.sort()).toEqual([1, 2, 3, 4]);
    const serial = parseJunitXml(reportOf(files));
    const merged = parseJunitXml(readFileSync(run.mergedPath, 'utf8'));
    expect(describeCaseDifference(serial.cases, merged.cases)).toBeNull();
  });

  it('retains serial Windows integration with Bun orphan cleanup', async () => {
    const plans: WorkerPlan[] = [];
    const worker = diskWorker(INTEGRATION_FILES);
    const run = harness((plan) => {
      plans.push(plan);
      return worker(plan);
    });
    expect(await main(INTEGRATION_ARGV, { ...run.deps, platform: 'win32' })).toBe(0);
    expect(run.started).toEqual([1]);
    expect(plans[0]?.settle).toBe(false);
    expect(plans[0]?.argv).toContain('--no-orphans');
    expect(plans[0]?.argv.some((arg) => arg.startsWith('--shard='))).toBe(false);
  });

  it('refuses arguments that name no lane or no command', async () => {
    const run = harness(diskWorker(REAL_FILES));
    await expect(main(['bun', 'test'], run.deps)).rejects.toThrow(
      'expected --lane=<id> -- <bun test command> | received: "bun test"'
    );
    await expect(main(['--lane=api-unit'], run.deps)).rejects.toThrow('expected --lane=<id>');
  });

  it('refuses a lane that declares no workers', async () => {
    const run = harness(diskWorker(REAL_FILES));
    await expect(
      main(['--lane=shared', '--', 'bun', 'test', 'tests/unit'], run.deps)
    ).rejects.toThrow('expected a lane with workers | received: shared');
  });

  it('refuses a worker count outside 1 to 8 before starting anything', async () => {
    const run = harness(diskWorker(REAL_FILES), { [WORKERS_ENV]: '12' });
    await expect(main(ARGV, run.deps)).rejects.toThrow(
      `expected ${WORKERS_ENV}: an integer from 1 to 8 | received: "12"`
    );
    expect(run.started).toEqual([]);
  });
});
