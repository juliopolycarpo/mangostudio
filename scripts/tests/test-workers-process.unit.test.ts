/**
 * The runner against real child processes: a stand-in for `bun test`
 * (support/fake-bun-test.ts) started through the same plan, pipes and signals
 * the lane uses. The verdict rules are in test-workers.unit.test.ts; this proves
 * the processes end up in them.
 */
import { afterEach, describe, expect, it, onTestFinished } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseJunitXml } from '../lib/junit-report';
import { CANCEL_GRACE_MS } from '../lib/process-tree';
import {
  EXIT_ABANDON_MS,
  pumpLines,
  type SpawnWorker,
  spawnWorkerChild,
  startWorkerProcess,
  type WorkerChild,
  workerEnvironment,
} from '../lib/test-worker-process';
import { SETTLE_GRACE_MS, WORKER_TOKEN_ENV } from '../lib/test-worker-settle';
import {
  GROUP_KILL_AFTER_MS,
  runWorkerLane,
  type WorkerLaneSpec,
  type WorkerPlan,
} from '../lib/test-workers';
import { fixtureChildEnvironment } from './support/child-supervision';
import { FAKE_BUN_TEST, FAKE_CASES_PER_FILE } from './support/fake-bun-test';
import {
  isAlive,
  type ProcessStateTable,
  type ProcessStatReader,
  readProcessState,
} from './support/process-liveness';
import { fakeLane } from './support/test-worker-fakes';
import {
  assertDrainPipeHolder,
  DrainFixtureScope,
  withOwnedDrainFixture,
} from './support/worker-drain-fixture';
import {
  settleWorkerLanesBeforeRemoval,
  trackWorkerHandle,
  trackWorkerStream,
  WorkerLaneOwner,
} from './support/worker-lane-cleanup';

const TEST_DIR = 'tests/unit';
const FILES = fakeLane(8, 1);
const workspaces: string[] = [];
const activeLanes: WorkerLaneOwner[] = [];

afterEach(async () => {
  const paths = workspaces.splice(0);
  const lanes = activeLanes.splice(0);
  await settleWorkerLanesBeforeRemoval(lanes, () => {
    for (const dir of paths) rmSync(dir, { recursive: true, force: true });
  });
});

/** Register a cancellation lane before it starts, for example `const owner = ownLane(controller)`. */
function ownLane(controller: AbortController): WorkerLaneOwner {
  const owner = new WorkerLaneOwner(controller);
  activeLanes.push(owner);
  onTestFinished(() => owner.close());
  return owner;
}

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
    owner?: WorkerLaneOwner;
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
    start: (plan) => {
      const handle = startWorkerProcess(
        plan,
        `[${spec.id} ${plan.index}/${plan.count}] `,
        sinks,
        options.drainGraceMs,
        env,
        (spawnOptions) => {
          const child = spawnWorkerChild(spawnOptions);
          if (!options.owner) return child;
          const owner = options.owner;
          owner.track(child.exited);
          return {
            pid: child.pid,
            stdout: trackWorkerStream(child.stdout, owner),
            stderr: trackWorkerStream(child.stderr, owner),
            exited: child.exited,
            get exitCode() {
              return child.exitCode;
            },
            get signalCode() {
              return child.signalCode;
            },
            kill: (signal) => child.kill(signal),
          };
        }
      );
      return options.owner ? trackWorkerHandle(handle, options.owner) : handle;
    },
  });
  return { ...result, lines, mergedPath, scratch };
}

type ProcessSignal = (pid: number, signal: NodeJS.Signals) => void;

function cleanupPids(
  pids: readonly number[],
  table: ProcessStateTable = readProcessState,
  signal: ProcessSignal = process.kill
): void {
  for (const pid of pids) {
    try {
      if (isAlive(pid, table)) signal(pid, 'SIGKILL');
    } catch {
      // Cleanup preserves the assertion failure and still tries every owned PID.
    }
  }
}

class FakeSuccessfulProcessStat {
  constructor(
    readonly comm: string,
    readonly state: string
  ) {}

  readonly read: ProcessStatReader = () => `4242 (${this.comm}) ${this.state} 1 4242 0`;
}

class FakeCleanupHost {
  readonly checked: number[] = [];
  readonly signalled: { pid: number; signal: NodeJS.Signals }[] = [];

  readonly table: ProcessStateTable = (pid) => {
    this.checked.push(pid);
    if (pid === 4100) throw new Error('process stat: EACCES');
    return pid === 4400 ? 'Z' : 'S';
  };

  readonly signal: ProcessSignal = (pid, signal) => {
    this.signalled.push({ pid, signal });
    if (pid === 4200) throw new Error('signal: ESRCH');
  };
}

class FakeZombieTable {
  readonly state: ProcessStateTable = () => 'Z';
}

class FakeLiveTable {
  readonly state: ProcessStateTable = () => 'S';
}

class FakeMissingTable {
  readonly state: ProcessStateTable = () => undefined;
}

class FakeUnreadableTable {
  readonly state: ProcessStateTable = () => {
    throw new Error('process table permission denied');
  };
}

class FakeInvalidTable {
  readonly state: ProcessStateTable = () => '?';
}

class FakeFailingProcessStat {
  constructor(readonly code: string) {}

  readonly read: ProcessStatReader = () => {
    throw Object.assign(new Error(`process stat: ${this.code}`), { code: this.code });
  };
}

describe('worker liveness assertions', () => {
  it.skipIf(process.platform !== 'linux')(
    'reads zombie and live states after command names containing spaces and parentheses',
    () => {
      for (const comm of ['cat fish', 'cat (fish) worker']) {
        for (const state of ['Z', 'S']) {
          const stat = new FakeSuccessfulProcessStat(comm, state);
          const table: ProcessStateTable = (pid) => readProcessState(pid, stat.read);
          expect(readProcessState(4242, stat.read)).toBe(state);
          expect(isAlive(4242, table)).toBe(state !== 'Z');
        }
      }
    }
  );

  it('continues cleanup after a PID probe or signal fails', () => {
    const host = new FakeCleanupHost();
    expect(() => cleanupPids([4100, 4200, 4300, 4400], host.table, host.signal)).not.toThrow();
    expect(host.checked).toEqual([4100, 4200, 4300, 4400]);
    expect(host.signalled).toEqual([
      { pid: 4200, signal: 'SIGKILL' },
      { pid: 4300, signal: 'SIGKILL' },
    ]);
  });

  it('preserves the original assertion failure when cleanup cannot read a PID', () => {
    const host = new FakeCleanupHost();
    expect(() => {
      try {
        throw new Error('original cancellation assertion');
      } finally {
        cleanupPids([4100, 4300], host.table, host.signal);
      }
    }).toThrow('original cancellation assertion');
    expect(host.signalled).toEqual([{ pid: 4300, signal: 'SIGKILL' }]);
  });

  it.skipIf(process.platform !== 'linux')(
    'accepts a process that exits during its stat read and rejects permission failures',
    () => {
      for (const code of ['ENOENT', 'ESRCH']) {
        expect(
          readProcessState(process.pid, new FakeFailingProcessStat(code).read)
        ).toBeUndefined();
      }
      expect(() =>
        readProcessState(process.pid, new FakeFailingProcessStat('EACCES').read)
      ).toThrow('process stat: EACCES');
    }
  );

  it('ignores an absent PID but refuses unreadable or invalid state', () => {
    expect(isAlive(process.pid, new FakeMissingTable().state)).toBe(false);
    expect(() => isAlive(process.pid, new FakeUnreadableTable().state)).toThrow(
      'process table permission denied'
    );
    expect(() => isAlive(process.pid, new FakeInvalidTable().state)).toThrow(
      `process ${process.pid}: expected a process state letter | received: "?"`
    );
  });

  it('ignores an unreaped zombie even when signal zero can still find its PID', () => {
    const zombie = new FakeZombieTable();
    expect(isAlive(process.pid, zombie.state), 'expected zombie state Z to be stopped').toBe(false);
  });

  it('still rejects a live descendant instead of weakening cancellation cleanup', () => {
    const live = new FakeLiveTable();
    expect(isAlive(process.pid, live.state), 'expected sleeping state S to remain live').toBe(true);
  });
});

describe('four real worker processes', () => {
  it('discards an ambient runtime home before starting workers', async () => {
    const { verdict, lines } = await runLane(
      2,
      {},
      {
        env: { ...process.env, MANGO_HOME: '/ambient/runtime-home' },
      }
    );
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
    const owner = ownLane(controller);
    owner.verify(() => {
      const alive = readdirSync(pidDir)
        .map((name) => readPid(pidDir, name))
        .filter((pid) => isAlive(pid));
      if (alive.length)
        throw new Error(
          `worker cleanup: expected live descendants: 0 | received: ${JSON.stringify(alive)}`
        );
    });
    const running = owner.start(() =>
      runLane(
        2,
        { 1: 'hang-tree', 2: 'hang-tree' },
        {
          settle: true,
          signal: controller.signal,
          pidDir,
          owner,
        }
      )
    );
    await owner.run(async () => {
      const up = await until(() => readdirSync(pidDir).length === 4, 10_000, controller.signal);
      const pids = readdirSync(pidDir).map((name) => readPid(pidDir, name));
      try {
        expect(up, 'expected two workers and two children running before cancellation').toBe(true);
        controller.abort();
        const { verdict } = await running;
        expect(verdict.failures).toHaveLength(2);
        expect(verdict.failures.every((failure) => failure.includes('was cancelled'))).toBe(true);
        expect(
          pids.filter((pid) => isAlive(pid)),
          'expected no live descendants after cancellation'
        ).toEqual([]);
      } finally {
        controller.abort();
        cleanupPids(pids);
      }
    });
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
      cleanupPids([leaked]);
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
        cleanupPids([leaked]);
      }
    }
  );

  it('are not checked when the lane does not ask for it', async () => {
    const { verdict, scratch } = await runLane(2, { 1: 'leak' }, { settle: false });
    const leaked = readPid(scratch, 'leak-1.pid');
    try {
      expect(verdict.failures).toEqual([]);
    } finally {
      cleanupPids([leaked]);
    }
  });
});

async function until(
  ready: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (ready()) return true;
    await Bun.sleep(25);
  }
  signal?.throwIfAborted();
  return ready();
}

describe('cancellation fixture readiness', () => {
  it('stops polling before touching storage after cancellation', async () => {
    const controller = new AbortController();
    let reads = 0;
    const heldReadiness = () => {
      reads += 1;
      return false;
    };
    const waiting = until(heldReadiness, 20_000, controller.signal).catch(
      (error: unknown) => error
    );
    expect(reads).toBe(1);
    controller.abort();
    expect(await waiting).toBe(controller.signal.reason);
    expect(reads).toBe(1);
  });
});

describe('a worker that leaks a process holding its pipes', () => {
  it('does not hold the lane open past the drain grace, and still passes', async () => {
    const controller = new AbortController();
    const lane = ownLane(controller);
    const scope = new DrainFixtureScope(controller.signal);
    lane.track(scope.closed);
    await lane.run(async () => {
      const owner = await scope.allocate();
      let pidDir = '';
      await withOwnedDrainFixture(scope, {
        async start() {
          controller.signal.throwIfAborted();
          pidDir = mkdtempSync(join(tmpdir(), 'mangostudio-worker-pids-'));
          workspaces.push(pidDir);
          const began = Date.now();
          scope.markLaneStarted();
          const result = await lane.start(() =>
            runLane(
              2,
              { 1: 'grandchild' },
              {
                pidDir,
                drainGraceMs: 300,
                env: fixtureChildEnvironment({ ...process.env, ...owner.env }),
                signal: controller.signal,
                owner: lane,
              }
            )
          );
          controller.signal.throwIfAborted();
          return { ...result, elapsed: Date.now() - began };
        },
        readPid: () => {
          controller.signal.throwIfAborted();
          return Number(readFileSync(join(pidDir, 'grandchild-1.pid'), 'utf8'));
        },
        async check({ verdict, elapsed }, observedPid) {
          expect(verdict.failures).toEqual([]);
          if (process.platform !== 'win32') {
            expect(await owner.ready()).toBe(observedPid);
            controller.signal.throwIfAborted();
            assertDrainPipeHolder(observedPid, owner.holdingPipes, isAlive);
            expect(
              elapsed,
              'expected the inherited pipes to require the drain grace'
            ).toBeGreaterThanOrEqual(300);
          }
          expect(
            elapsed,
            `expected the lane to end soon after the drain grace | received ${elapsed} ms with a leaked process holding the pipes`
          ).toBeLessThan(10_000);
        },
      });
      expect(owner.settled, 'expected the retained drain connection and listener to close').toBe(
        true
      );
    });
  });
});

describe('cancelling real worker processes', () => {
  it('ends every worker and fails the lane naming each', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'mangostudio-worker-pids-'));
    workspaces.push(pidDir);
    const controller = new AbortController();
    const owner = ownLane(controller);
    owner.verify(() => {
      const alive = readdirSync(pidDir)
        .map((name) => readPid(pidDir, name))
        .filter((pid) => isAlive(pid));
      if (alive.length)
        throw new Error(
          `worker cleanup: expected live workers: 0 | received: ${JSON.stringify(alive)}`
        );
    });
    const running = owner.start(() =>
      runLane(3, { 1: 'hang', 2: 'hang', 3: 'hang' }, { signal: controller.signal, pidDir, owner })
    );

    await owner.run(async () => {
      // Cancel only once every worker is up, or a late one would never be signalled.
      await until(() => readdirSync(pidDir).length >= 3, 20_000, controller.signal);
      expect(
        readdirSync(pidDir).sort(),
        'expected all 3 workers running before cancelling'
      ).toEqual(['worker-1.pid', 'worker-2.pid', 'worker-3.pid']);
      const pids = readdirSync(pidDir).map((name) =>
        Number(readFileSync(join(pidDir, name), 'utf8'))
      );
      controller.abort();
      const { verdict } = await running;

      expect(verdict.failures.filter((failure) => failure.includes('was cancelled'))).toHaveLength(
        3
      );
      expect(verdict.failures[0]).toContain('api-unit worker 1/3 was cancelled');
      const alive = pids.filter((pid) => isAlive(pid));
      expect(alive, `expected live workers: 0 | received: ${alive.length} (pids ${alive})`).toEqual(
        []
      );
    });
  });
});

describe('the cancellation budget of a settling worker', () => {
  it('ends its slowest teardown before the outer supervisor kills the lane', () => {
    const slowest = GROUP_KILL_AFTER_MS + EXIT_ABANDON_MS + SETTLE_GRACE_MS;
    const margin = CANCEL_GRACE_MS - slowest;

    expect(
      margin,
      `expected escalation + abandoned exit wait + settlement grace at least 500 ms inside CANCEL_GRACE_MS (${CANCEL_GRACE_MS} ms) | received: ${GROUP_KILL_AFTER_MS} + ${EXIT_ABANDON_MS} + ${SETTLE_GRACE_MS} = ${slowest} ms`
    ).toBeGreaterThanOrEqual(500);
  });
});

describe('a worker whose exit is never reported', () => {
  const started: WorkerChild[] = [];

  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL');
  });

  /**
   * A real child whose handle never reports the exit: `exited` stays pending
   * and no exit code or signal is recorded, as Bun 1.4.3 can leave a SIGKILLed
   * detached child.
   */
  const spawnWedgedExitChild =
    (exited: Promise<never>): SpawnWorker =>
    (options) => {
      const real = spawnWorkerChild(options);
      started.push(real);
      return {
        pid: real.pid,
        stdout: real.stdout,
        stderr: real.stderr,
        exited,
        exitCode: null,
        signalCode: null,
        kill: (signal) => real.kill(signal),
      };
    };

  const STILL_WAITING = 'still waiting on child.exited';

  function startWedged(settle: boolean, exited = new Promise<never>(() => undefined)) {
    const plan: WorkerPlan = {
      index: 1,
      count: 1,
      laneId: 'wedged',
      cwd: tmpdir(),
      argv: [process.execPath, '-e', 'await Bun.sleep(30_000)'],
      reportPath: '',
      settle,
      env: settle ? { [WORKER_TOKEN_ENV]: `wedged-${process.pid}-${Date.now()}` } : {},
    };
    const ignore = (): void => undefined;
    const handle = startWorkerProcess(
      plan,
      '',
      { out: ignore, err: ignore },
      100,
      fixtureChildEnvironment(),
      spawnWedgedExitChild(exited)
    );
    const within = (ms: number) =>
      Promise.race([handle.exited, Bun.sleep(ms).then(() => STILL_WAITING)]);
    return { handle, within };
  }

  it.skipIf(process.platform === 'win32')(
    'reports a killed group leader as SIGKILLed instead of waiting on it',
    async () => {
      const { handle, within } = startWedged(true);

      handle.kill('SIGKILL');

      expect(
        await within(3_000),
        'expected worker exit: { exitCode: null, signal: SIGKILL } once the exit wait is abandoned'
      ).toEqual({ exitCode: null, signal: 'SIGKILL' });
      expect(await handle.settle?.(), 'expected the killed group to leave nothing behind').toEqual(
        []
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'handles an exit that fails only after the wait was abandoned',
    async () => {
      const lateExit = Promise.withResolvers<never>();
      const unhandled: unknown[] = [];
      const record = (reason: unknown): void => void unhandled.push(reason);
      process.on('unhandledRejection', record);
      try {
        const { handle, within } = startWedged(true, lateExit.promise);
        handle.kill('SIGKILL');
        // Without this the reject below could land while the wait is still
        // pending, where the lane's own catch handles it.
        expect(
          await within(3_000),
          'expected worker exit: { exitCode: null, signal: SIGKILL } before the exit fails'
        ).toEqual({ exitCode: null, signal: 'SIGKILL' });

        lateExit.reject(new Error('late pipe failure'));
        // Unhandled rejections are reported a turn of the event loop later.
        await Bun.sleep(50);

        expect(
          unhandled.map(String),
          'expected unhandled rejections after the abandoned exit wait: none'
        ).toEqual([]);
      } finally {
        process.off('unhandledRejection', record);
      }
    }
  );

  it('keeps waiting on a plain child, whose kill nothing else confirms', async () => {
    const { handle, within } = startWedged(false);

    handle.kill('SIGKILL');

    expect(await within(1_000), 'expected no synthesized exit for a worker without a group').toBe(
      STILL_WAITING
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
