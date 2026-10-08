import { describe, expect, test } from 'bun:test';

import {
  CANCEL_GRACE_MS,
  type CancelSignal,
  CHILD_LIMIT_ENV,
  ChildSupervisor,
  cancelExitStatus,
  childLimit,
  createDescendantBinder,
  DEFAULT_CHILD_LIMIT,
  DIRECT_SIGINT_DELAY_MS,
  isNestedRunner,
  type ProcessProbe,
  psProbe,
  RUNNER_GROUP_ENV,
  SlotPool,
  type SupervisedChild,
  type SupervisorHost,
  supervisionMode,
} from '../lib/process-tree';

// The real thing (which pids survive a cancelled runner) is covered with live
// processes in exec-process-tree.unit.test.ts. These tests pin the decisions
// the supervisor makes, which a live run cannot reach without waiting out its
// grace period: who gets which signal, how often, and when it escalates.

/** A named stand-in for the running process: it records, and time only moves when told. */
class FakeProcessHost implements SupervisorHost {
  readonly graceMs = CANCEL_GRACE_MS;
  readonly groupKills: Array<[pid: number, signal: string]> = [];
  readonly exitStatuses: number[] = [];
  readonly reports: string[] = [];
  readonly exited: Promise<void>;
  private resolveExited: () => void = () => undefined;
  private clock = 0;
  /** Groups that still have a running member, whatever became of their leader. */
  readonly liveGroups = new Set<number>();
  /** What `stdinIsTerminal()` answers. */
  terminal = true;
  private readonly signalHandlers = new Map<CancelSignal, () => void>();
  private exitHandlers = new Set<() => void>();
  private sleepers: Array<{ wakeAt: number; wake: () => void }> = [];

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
  }

  get handlersInstalled(): number {
    return this.signalHandlers.size + this.exitHandlers.size;
  }

  onSignal(name: CancelSignal, handler: () => void): () => void {
    this.signalHandlers.set(name, handler);
    return () => {
      this.signalHandlers.delete(name);
    };
  }

  onExit(handler: () => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  killGroup(pid: number, signal: NodeJS.Signals): void {
    this.groupKills.push([pid, signal]);
    // Only SIGKILL stops the members this fake models: they ignore the rest.
    if (signal === 'SIGKILL') this.liveGroups.delete(pid);
  }

  groupAlive(pid: number): boolean {
    return this.liveGroups.has(pid);
  }

  stdinIsTerminal(): boolean {
    return this.terminal;
  }

  // A real exit never returns; the fake records it and lets the test carry on.
  exit(status: number): never {
    this.exitStatuses.push(status);
    this.resolveExited();
    return undefined as never;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ wakeAt: this.clock + ms, wake: resolve });
    });
  }

  now(): number {
    return this.clock;
  }

  report(message: string): void {
    this.reports.push(message);
  }

  /** What the terminal or a `kill` does: deliver `name` to the process. */
  deliver(name: CancelSignal): void {
    this.signalHandlers.get(name)?.();
  }

  /** The process is ending of its own accord (`process.exit`, an uncaught error). */
  endProcess(): void {
    for (const handler of this.exitHandlers) handler();
  }

  /**
   * Moves the clock forward in 25 ms steps, letting the supervisor's polling
   * loop run between them, as it would over real time.
   */
  async advance(ms: number): Promise<void> {
    for (let moved = 0; moved < ms; moved += 25) {
      this.clock += Math.min(25, ms - moved);
      const due = this.sleepers.filter((sleeper) => sleeper.wakeAt <= this.clock);
      this.sleepers = this.sleepers.filter((sleeper) => sleeper.wakeAt > this.clock);
      for (const sleeper of due) sleeper.wake();
      await settle();
    }
  }
}

/** A named stand-in for one spawned command. */
class FakeChild implements SupervisedChild {
  readonly signals: string[] = [];
  readonly exited: Promise<unknown>;
  private resolveExited: () => void = () => undefined;

  constructor(
    readonly label: string,
    readonly pid: number,
    readonly ownsGroup: boolean
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = () => resolve(0);
    });
  }

  signal(signal: NodeJS.Signals): void {
    this.signals.push(signal);
  }

  exit(): void {
    this.resolveExited();
  }
}

/** Lets the supervisor's pending continuations run. */
const settle = (): Promise<void> => Bun.sleep(0);

describe('childLimit', () => {
  test('is the default when nothing is set', () => {
    expect(childLimit({})).toBe(DEFAULT_CHILD_LIMIT);
    expect(childLimit({ [CHILD_LIMIT_ENV]: '' })).toBe(DEFAULT_CHILD_LIMIT);
  });

  test('reads a positive integer from the environment', () => {
    expect(childLimit({ [CHILD_LIMIT_ENV]: '4' })).toBe(4);
  });

  test.each(['0', '-2', '2.5', 'many'])('rejects %p naming the value and the shape', (raw) => {
    expect(() => childLimit({ [CHILD_LIMIT_ENV]: raw })).toThrow(
      `Invalid ${CHILD_LIMIT_ENV}: ${raw} | expected a positive integer`
    );
  });

  test('default covers the widest fan-out in use, 13 tasks with the powerset split', () => {
    expect(DEFAULT_CHILD_LIMIT).toBeGreaterThanOrEqual(13);
  });
});

describe('supervisionMode', () => {
  test('puts a plain child in its own group on POSIX', () => {
    expect(supervisionMode('ignore', 'linux', false)).toBe('group');
    expect(supervisionMode(undefined, 'darwin', false)).toBe('group');
  });

  test('keeps an interactive child in the terminal foreground group', () => {
    expect(supervisionMode('inherit', 'linux', false)).toBe('direct');
  });

  test('leaves Windows to the job object the runner puts itself in', () => {
    expect(supervisionMode('ignore', 'win32', false)).toBe('none');
    expect(supervisionMode('inherit', 'win32', false)).toBe('none');
  });

  test('leaves a nested runner in the group the runner above owns', () => {
    expect(supervisionMode('ignore', 'linux', true)).toBe('none');
  });
});

describe('isNestedRunner', () => {
  const OWNER = 4242;
  const SELF = 5000;
  const LEADER = 4999;

  /** A table of `pid -> { ppid, pgid }`, standing in for the process table. */
  const processTable =
    (rows: Record<number, { ppid: number; pgid: number }>): ProcessProbe =>
    (pid) =>
      rows[pid];

  const marker = { [RUNNER_GROUP_ENV]: String(OWNER) };

  test('is true when this process is in a group led by a child of the named runner', () => {
    const probe = processTable({
      [SELF]: { ppid: LEADER, pgid: LEADER },
      [LEADER]: { ppid: OWNER, pgid: LEADER },
    });

    expect(isNestedRunner(marker, probe, SELF)).toBe(true);
  });

  test('is true for the child the runner spawned itself, which leads the group', () => {
    const probe = processTable({ [SELF]: { ppid: OWNER, pgid: SELF } });

    expect(isNestedRunner(marker, probe, SELF)).toBe(true);
  });

  test('is false when the group leader belongs to someone else', () => {
    const probe = processTable({
      [SELF]: { ppid: LEADER, pgid: LEADER },
      [LEADER]: { ppid: 1, pgid: LEADER },
    });

    expect(isNestedRunner(marker, probe, SELF)).toBe(false);
  });

  test('is false for a process that left the group, whose own leader is its parent', () => {
    const probe = processTable({ [SELF]: { ppid: 1, pgid: SELF } });

    expect(isNestedRunner(marker, probe, SELF)).toBe(false);
  });

  test('is false when the leader is gone, since nobody signals that group any more', () => {
    const probe = processTable({ [SELF]: { ppid: 1, pgid: LEADER } });

    expect(isNestedRunner(marker, probe, SELF)).toBe(false);
  });

  test('is false when the process table cannot be read', () => {
    expect(isNestedRunner(marker, () => undefined, SELF)).toBe(false);
  });

  test.each([undefined, '', 'abc', '0', '-3', '4.5'])('is false for the marker %p', (raw) => {
    const probe = processTable({ [SELF]: { ppid: OWNER, pgid: SELF } });

    expect(isNestedRunner({ [RUNNER_GROUP_ENV]: raw }, probe, SELF)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('psProbe', () => {
  test('reads the parent and group of this process', () => {
    const found = psProbe(process.pid);

    expect(found?.ppid).toBe(process.ppid);
    expect(found?.pgid).toBeGreaterThan(0);
  });

  test('has nothing to say about a process that does not exist', () => {
    expect(psProbe(2 ** 22 + 1)).toBeUndefined();
  });
});

describe('createDescendantBinder', () => {
  test('does nothing off Windows', async () => {
    let created = 0;
    const bind = createDescendantBinder(
      'linux',
      () => {
        created += 1;
        return Promise.resolve();
      },
      () => undefined
    );
    await bind();

    expect(created).toBe(0);
  });

  test('creates the job once however often it is asked', async () => {
    let created = 0;
    const bind = createDescendantBinder(
      'win32',
      () => {
        created += 1;
        return Promise.resolve();
      },
      () => undefined
    );
    await Promise.all([bind(), bind()]);
    await bind();

    expect(created).toBe(1);
  });

  test('fails open: a job that cannot be created is reported once and the run goes on', async () => {
    const reports: string[] = [];
    const bind = createDescendantBinder(
      'win32',
      () => Promise.reject(new Error('AssignProcessToJobObject failed with error 5')),
      (message) => reports.push(message)
    );

    await bind();
    await bind();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('AssignProcessToJobObject failed with error 5');
    expect(reports[0]).toContain('may keep running');
  });
});

describe('cancelExitStatus', () => {
  test('is 128 plus the signal number, as a shell reports it', () => {
    expect(cancelExitStatus('SIGHUP')).toBe(129);
    expect(cancelExitStatus('SIGINT')).toBe(130);
    expect(cancelExitStatus('SIGTERM')).toBe(143);
  });
});

describe('SlotPool', () => {
  test.each([0, -1, 1.5, Number.NaN])('rejects a limit of %p', (limit) => {
    expect(() => new SlotPool(limit)).toThrow(
      `limit must be a positive integer, received ${limit}`
    );
  });

  test('hands out slots up to the limit and queues the rest in order', async () => {
    const pool = new SlotPool(2);
    const order: string[] = [];
    const first = await pool.acquire();
    const second = await pool.acquire();
    const third = pool.acquire().then((release) => {
      order.push('third');
      return release;
    });
    const fourth = pool.acquire().then((release) => {
      order.push('fourth');
      return release;
    });
    await settle();

    expect(pool.inUse).toBe(2);
    expect(order).toEqual([]);

    first();
    await settle();
    expect(order).toEqual(['third']);

    second();
    await settle();
    expect(order).toEqual(['third', 'fourth']);
    (await third)();
    (await fourth)();
    expect(pool.inUse).toBe(0);
  });

  test('a slot released twice is freed once', async () => {
    const pool = new SlotPool(1);
    const release = await pool.acquire();
    release();
    release();
    const again = await pool.acquire();

    expect(pool.inUse).toBe(1);
    let waiterRan = false;
    const waiter = pool.acquire().then(() => {
      waiterRan = true;
    });
    await settle();
    expect(waiterRan).toBe(false);

    again();
    await waiter;
  });
});

describe('ChildSupervisor', () => {
  /**
   * Adopts `child` as `runCommand` does, releasing it when it exits; a child that
   * leads a group also gets a live member in it.
   */
  const watch = (host: FakeProcessHost, supervisor: ChildSupervisor, child: FakeChild) => {
    if (child.ownsGroup) host.liveGroups.add(child.pid);
    const release = supervisor.adopt(child);
    void child.exited.then(release);
    return release;
  };

  /** The child exits and, unless a member outlives it, its group empties with it. */
  const stop = (host: FakeProcessHost, child: FakeChild, memberSurvives = false) => {
    child.exit();
    if (!memberSurvives) host.liveGroups.delete(child.pid);
  };

  test('installs its handlers while a child is live and removes them after', () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    expect(host.handlersInstalled).toBe(0);

    const releaseA = watch(host, supervisor, new FakeChild('a', 101, true));
    const releaseB = watch(host, supervisor, new FakeChild('b', 102, true));
    expect(host.handlersInstalled).toBe(4);

    releaseA();
    expect(host.handlersInstalled).toBe(4);
    releaseB();
    expect(host.handlersInstalled).toBe(0);
  });

  test('SIGTERM reaches the group of each owning child once and the pid of the others', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const grouped = new FakeChild('lane-group', 101, true);
    const interactive = new FakeChild('lane-tty', 102, false);
    watch(host, supervisor, grouped);
    watch(host, supervisor, interactive);

    host.deliver('SIGTERM');

    expect(host.groupKills).toEqual([[101, 'SIGTERM']]);
    expect(grouped.signals).toEqual([]);
    expect(interactive.signals).toEqual(['SIGTERM']);
    expect(supervisor.cancelling).toBe(true);
    expect(host.reports.join('\n')).toContain('lane-group, lane-tty');

    stop(host, grouped);
    stop(host, interactive);
    await host.advance(25);
    await host.exited;
    expect(host.exitStatuses).toEqual([143]);
  });

  test('a repeat of the signal inside the window is the same keypress', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const child = new FakeChild('lane', 101, true);
    watch(host, supervisor, child);

    host.deliver('SIGINT');
    await host.advance(200);
    host.deliver('SIGINT');

    expect(host.groupKills).toEqual([[101, 'SIGINT']]);
    stop(host, child);
    await host.advance(25);
    await host.exited;
    expect(host.exitStatuses).toEqual([130]);
  });

  test('kills what ignored the signal for the whole grace period', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const stubborn = new FakeChild('lane-stubborn', 101, true);
    watch(host, supervisor, stubborn);

    host.deliver('SIGTERM');
    await host.advance(CANCEL_GRACE_MS - 25);
    expect(host.groupKills).toEqual([[101, 'SIGTERM']]);

    await host.advance(25);
    await host.advance(25);
    expect(host.groupKills).toEqual([
      [101, 'SIGTERM'],
      [101, 'SIGKILL'],
    ]);
    expect(host.reports.join('\n')).toContain('lane-stubborn');

    await host.exited;
    expect(host.exitStatuses).toEqual([143]);
  });

  // The leader exiting says nothing about the rest of its group.
  describe('a group member that outlives its leader', () => {
    test('is waited for until it stops on its own', async () => {
      const host = new FakeProcessHost();
      const supervisor = new ChildSupervisor(host);
      const leader = new FakeChild('lane', 101, true);
      watch(host, supervisor, leader);

      host.deliver('SIGTERM');
      stop(host, leader, true);
      await host.advance(3_000);
      expect(host.exitStatuses).toEqual([]);

      host.liveGroups.delete(101);
      await host.advance(25);
      await host.exited;

      expect(host.groupKills).toEqual([[101, 'SIGTERM']]);
      expect(host.exitStatuses).toEqual([143]);
    });

    test('is SIGKILLed when it ignores the signal for the whole grace period', async () => {
      const host = new FakeProcessHost();
      const supervisor = new ChildSupervisor(host);
      const leader = new FakeChild('lane', 101, true);
      watch(host, supervisor, leader);

      host.deliver('SIGTERM');
      stop(host, leader, true);
      await host.advance(CANCEL_GRACE_MS - 25);
      expect(host.exitStatuses).toEqual([]);
      expect(host.groupKills).toEqual([[101, 'SIGTERM']]);

      await host.advance(50);
      await host.exited;

      expect(host.groupKills).toEqual([
        [101, 'SIGTERM'],
        [101, 'SIGKILL'],
      ]);
      expect(host.exitStatuses).toEqual([143]);
    });

    test('is SIGKILLed at once when a second signal arrives after the window', async () => {
      const host = new FakeProcessHost();
      const supervisor = new ChildSupervisor(host);
      const leader = new FakeChild('lane', 101, true);
      watch(host, supervisor, leader);

      host.deliver('SIGINT');
      stop(host, leader, true);
      await host.advance(1_500);
      host.deliver('SIGINT');

      expect(host.groupKills).toEqual([
        [101, 'SIGINT'],
        [101, 'SIGKILL'],
      ]);
      expect(host.exitStatuses).toEqual([130]);
    });
  });

  test('a second signal after the window stops waiting and kills at once', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    watch(host, supervisor, new FakeChild('lane', 101, true));

    host.deliver('SIGINT');
    await host.advance(1_500);
    host.deliver('SIGINT');

    expect(host.groupKills).toEqual([
      [101, 'SIGINT'],
      [101, 'SIGKILL'],
    ]);
    await host.exited;
    expect(host.exitStatuses).toEqual([130]);
  });

  // A Ctrl-C typed at the terminal reaches an interactive child from the
  // kernel; one sent to the runner alone reaches nothing.
  describe('SIGINT for an interactive child', () => {
    test('is delivered at once when stdin is no terminal, so nothing typed it', async () => {
      const host = new FakeProcessHost();
      host.terminal = false;
      const supervisor = new ChildSupervisor(host);
      const interactive = new FakeChild('lane-tty', 102, false);
      watch(host, supervisor, interactive);

      host.deliver('SIGINT');

      expect(interactive.signals).toEqual(['SIGINT']);
      stop(host, interactive);
      await host.advance(25);
      await host.exited;
      expect(host.exitStatuses).toEqual([130]);
    });

    test('is not repeated on a terminal while the child stops on its own', async () => {
      const host = new FakeProcessHost();
      const supervisor = new ChildSupervisor(host);
      const interactive = new FakeChild('lane-tty', 102, false);
      const release = watch(host, supervisor, interactive);

      host.deliver('SIGINT');
      await host.advance(DIRECT_SIGINT_DELAY_MS - 25);
      expect(interactive.signals).toEqual([]);

      // It had the Ctrl-C from the kernel and is shutting down.
      stop(host, interactive);
      release();
      await host.advance(DIRECT_SIGINT_DELAY_MS);
      await host.exited;

      expect(interactive.signals).toEqual([]);
      expect(host.exitStatuses).toEqual([130]);
    });

    test('becomes SIGTERM on a terminal when the child is still running a second later', async () => {
      const host = new FakeProcessHost();
      const supervisor = new ChildSupervisor(host);
      const interactive = new FakeChild('lane-tty', 102, false);
      const release = watch(host, supervisor, interactive);

      host.deliver('SIGINT');
      await host.advance(DIRECT_SIGINT_DELAY_MS);

      expect(interactive.signals).toEqual(['SIGTERM']);
      stop(host, interactive);
      release();
      await host.advance(25);
      await host.exited;
      expect(host.exitStatuses).toEqual([130]);
    });

    test('SIGTERM and SIGHUP are delivered at once, terminal or not', () => {
      for (const name of ['SIGTERM', 'SIGHUP'] as const) {
        const host = new FakeProcessHost();
        const supervisor = new ChildSupervisor(host);
        const interactive = new FakeChild('lane-tty', 102, false);
        watch(host, supervisor, interactive);

        host.deliver(name);

        expect(interactive.signals).toEqual([name]);
      }
    });
  });

  test('a runner that ends on its own takes live children down with SIGTERM', () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const grouped = new FakeChild('lane-group', 101, true);
    const interactive = new FakeChild('lane-tty', 102, false);
    watch(host, supervisor, grouped);
    watch(host, supervisor, interactive);

    host.endProcess();

    expect(host.groupKills).toEqual([[101, 'SIGTERM']]);
    expect(interactive.signals).toEqual(['SIGTERM']);
    expect(host.exitStatuses).toEqual([]);
  });
});
