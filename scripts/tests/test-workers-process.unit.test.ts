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
import type { GuardedChild } from '../lib/runner-guardian';
import {
  EXIT_ABANDON_MS,
  guardWorkerSpawn,
  pumpLines,
  type SpawnWorker,
  spawnWorkerChild,
  startWorkerProcess,
  type WorkerChild,
  workerEnvironment,
  type WorkerGuardian,
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
  type PsStateAnswer,
  readProcessState,
  readPsProcessState,
  TRANSITIONAL_STATE_READS,
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

/** A `ps` that answers from a script, then repeats its last answer, and records each pause. */
class FakeSequencedPs {
  queries = 0;
  readonly pauses: number[] = [];

  constructor(private readonly answers: readonly PsStateAnswer[]) {}

  readonly query = (): PsStateAnswer => {
    const answer = this.answers[Math.min(this.queries, this.answers.length - 1)];
    this.queries++;
    if (!answer) throw new Error('FakeSequencedPs: expected at least one scripted answer');
    return answer;
  };

  readonly pause = (milliseconds: number): void => {
    this.pauses.push(milliseconds);
  };
}

const psState = (state: string): PsStateAnswer => ({
  exitCode: 0,
  stdout: `${state}\n`,
  stderr: '',
});
const PS_GONE: PsStateAnswer = { exitCode: 1, stdout: '', stderr: '' };

describe('ps process state reader', () => {
  // macOS prints `?` for a process caught while it is created or torn down;
  // that instant failed a cancellation test whose child was exiting.
  it('rereads a transitional state until ps reports a letter', () => {
    const ps = new FakeSequencedPs([psState('?'), psState('?'), psState('S+')]);
    expect(readPsProcessState(4242, ps.query, ps.pause)).toBe('S');
    expect(ps.queries, 'expected two rereads after two transitional answers').toBe(3);
    expect(ps.pauses).toEqual([5, 5]);
  });

  it('reports a process that exits during the rereads as absent', () => {
    const ps = new FakeSequencedPs([psState('?'), PS_GONE]);
    expect(readPsProcessState(4242, ps.query, ps.pause)).toBeUndefined();
    expect(isAlive(4242, (pid) => readPsProcessState(pid, ps.query, ps.pause))).toBe(false);
  });

  it('returns a state that stays transitional so liveness still refuses it', () => {
    const ps = new FakeSequencedPs([psState('?')]);
    expect(readPsProcessState(4242, ps.query, ps.pause)).toBe('?');
    expect(ps.queries, 'expected the bounded number of reads').toBe(TRANSITIONAL_STATE_READS);
    expect(() => isAlive(4242, (pid) => readPsProcessState(pid, ps.query, ps.pause))).toThrow(
      'process 4242: expected a process state letter | received: "?"'
    );
  });

  it('answers a settled state with one query and no pause', () => {
    const ps = new FakeSequencedPs([psState('Z')]);
    expect(readPsProcessState(4242, ps.query, ps.pause)).toBe('Z');
    expect(ps.queries).toBe(1);
    expect(ps.pauses).toEqual([]);
  });

  it('refuses a failed or malformed ps answer on the first read', () => {
    const denied = new FakeSequencedPs([{ exitCode: 2, stdout: '', stderr: 'ps: not permitted' }]);
    expect(() => readPsProcessState(4242, denied.query, denied.pause)).toThrow(
      'process 4242: expected readable process state | received: exit 2, "", "ps: not permitted"'
    );
    const malformed = new FakeSequencedPs([psState('S s')]);
    expect(() => readPsProcessState(4242, malformed.query, malformed.pause)).toThrow(
      'process 4242: expected readable process state | received: exit 0, "S s", ""'
    );
  });
});

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
      files: null,
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

/** A guardian link that records what the lane asked of it, in order. */
class FakeWorkerGuardian implements WorkerGuardian {
  readonly events: string[] = [];

  open(): void {
    this.events.push('open');
  }

  watch(child: GuardedChild): () => void {
    this.events.push(`watch ${child.kind} ${child.pid}`);
    return () => {
      this.events.push(`release ${child.pid}`);
    };
  }
}

/** A worker child that exits, or whose exit wait fails, when the test says so. */
class FakeWorkerChild implements WorkerChild {
  readonly stdout = new ReadableStream<Uint8Array>();
  readonly stderr = new ReadableStream<Uint8Array>();
  readonly exitCode = null;
  readonly signalCode = null;
  private readonly exit = Promise.withResolvers<unknown>();
  readonly exited = this.exit.promise;

  constructor(readonly pid: number) {}

  kill(): void {}

  leave(): void {
    this.exit.resolve(0);
  }

  failExitWait(): void {
    this.exit.reject(new Error('exit wait failed'));
  }
}

describe('guardWorkerSpawn', () => {
  const options = { cmd: ['bun', 'test'], cwd: '/repo', env: {} };

  /** A guarded spawn over fakes: the guardian's record and the one child it starts. */
  const guarded = (pid: number) => {
    const guardian = new FakeWorkerGuardian();
    const child = new FakeWorkerChild(pid);
    const spawn = guardWorkerSpawn(guardian, () => {
      guardian.events.push('spawn');
      return child;
    });
    return { guardian, child, spawn };
  };

  it('opens the guardian before the spawn and registers a group leader as its group', () => {
    const { guardian, child, spawn } = guarded(4101);

    expect(spawn({ ...options, detached: true })).toBe(child);
    expect(guardian.events).toEqual(['open', 'spawn', 'watch group 4101']);
  });

  it('registers a worker that leads no group by its pid alone', () => {
    const { guardian, spawn } = guarded(4102);

    spawn({ ...options, detached: false });
    expect(guardian.events).toEqual(['open', 'spawn', 'watch pid 4102']);
  });

  it('deregisters the worker once it has exited', async () => {
    const { guardian, child, spawn } = guarded(4103);
    spawn({ ...options, detached: true });

    child.leave();
    await child.exited;
    expect(guardian.events.at(-1)).toBe('release 4103');
  });

  it('deregisters the worker when its exit wait fails', async () => {
    const { guardian, child, spawn } = guarded(4104);
    spawn({ ...options, detached: true });

    child.failExitWait();
    await child.exited.catch(() => undefined);
    expect(guardian.events.at(-1)).toBe('release 4104');
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

  /** The lines a whole-stream reader reports: complete ones CR-trimmed, the unterminated rest as is. */
  function linesOfWholeStream(bytes: Uint8Array): string[] {
    const parts = new TextDecoder().decode(bytes).split('\n');
    const rest = parts.pop() ?? '';
    const lines = parts.map((line) => line.replace(/\r$/, ''));
    return rest === '' ? lines : [...lines, rest];
  }

  function streamOfByteCuts(
    bytes: Uint8Array,
    cuts: readonly number[]
  ): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        let start = 0;
        for (const cut of [...cuts, bytes.byteLength]) {
          controller.enqueue(bytes.slice(start, cut));
          start = cut;
        }
        controller.close();
      },
    });
  }

  it('reports the same lines as splitting the whole stream, however the bytes are cut', async () => {
    // 2, 3 and 4 byte characters, CRLF, a blank line and an unterminated rest.
    const bytes = new TextEncoder().encode('café\r\n✓ ok\n\n\u{1f96d}\r\nlast\r');
    const expected = linesOfWholeStream(bytes);

    for (let cut = 0; cut <= bytes.byteLength; cut += 1) {
      const lines: string[] = [];
      await pumpLines(streamOfByteCuts(bytes, [cut]), (line) => lines.push(line));
      expect({ cut, lines }).toEqual({ cut, lines: expected });
    }
    const oneByteReads: string[] = [];
    const everyByte = Array.from({ length: bytes.byteLength - 1 }, (_, index) => index + 1);
    await pumpLines(streamOfByteCuts(bytes, everyByte), (line) => oneByteReads.push(line));
    expect(oneByteReads).toEqual(expected);
  });

  it('reports a line over the limit once, with its length and the limit, and drains the rest', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('fine\n'));
        else if (pulls <= 5) controller.enqueue(new TextEncoder().encode('x'.repeat(4)));
        else controller.close();
      },
    });
    const lines: string[] = [];

    await pumpLines(stream, (line) => lines.push(line), undefined, 10);

    expect(lines).toEqual([
      'fine',
      '(NewlineSplitter): line length 12 exceeds the cap | expected at most 10 characters before the newline',
    ]);
    // Every chunk was still read, so the child is never blocked on a full pipe.
    expect(pulls).toBe(6);
  });

  it('accepts a line of exactly the limit', async () => {
    const lines: string[] = [];

    await pumpLines(
      streamOf('a'.repeat(10), '\n', 'b'.repeat(10)),
      (line) => lines.push(line),
      undefined,
      10
    );

    expect(lines).toEqual(['a'.repeat(10), 'b'.repeat(10)]);
  });

  // The reader used to search the whole pending text on every read: a 1 MiB
  // line in 16-byte reads took several seconds. The bound separates linear from
  // quadratic; it is no benchmark.
  it('delivers a 1 MiB line read in 16-byte pieces within 1500 ms', async () => {
    const bytes = new TextEncoder().encode(`${'a'.repeat(1024 * 1024)}\n`);
    const everySixteen = Array.from(
      { length: Math.floor((bytes.byteLength - 1) / 16) },
      (_, index) => (index + 1) * 16
    );
    const lines: string[] = [];

    const startedAt = performance.now();
    await pumpLines(streamOfByteCuts(bytes, everySixteen), (line) => lines.push(line));
    const elapsedMs = performance.now() - startedAt;

    expect(lines.map((line) => line.length)).toEqual([1024 * 1024]);
    expect(elapsedMs).toBeLessThan(1500);
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
