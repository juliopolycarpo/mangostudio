import { describe, expect, test } from 'bun:test';

import {
  CANCEL_GRACE_MS,
  type CancelSignal,
  CHILD_LIMIT_ENV,
  ChildSupervisor,
  cancelExitStatus,
  childLimit,
  DEFAULT_CHILD_LIMIT,
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

  advance(ms: number): void {
    this.clock += ms;
    const due = this.sleepers.filter((sleeper) => sleeper.wakeAt <= this.clock);
    this.sleepers = this.sleepers.filter((sleeper) => sleeper.wakeAt > this.clock);
    for (const sleeper of due) sleeper.wake();
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
    expect(supervisionMode('ignore', 'linux', {})).toBe('group');
    expect(supervisionMode(undefined, 'darwin', {})).toBe('group');
  });

  test('keeps an interactive child in the terminal foreground group', () => {
    expect(supervisionMode('inherit', 'linux', {})).toBe('direct');
  });

  test('leaves Windows to the job object Bun gives the runner', () => {
    expect(supervisionMode('ignore', 'win32', {})).toBe('none');
    expect(supervisionMode('inherit', 'win32', {})).toBe('none');
  });

  test('leaves a nested runner in the group the runner above owns', () => {
    expect(supervisionMode('ignore', 'linux', { [RUNNER_GROUP_ENV]: '4242' })).toBe('none');
  });

  test('treats an empty marker as not nested', () => {
    expect(supervisionMode('ignore', 'linux', { [RUNNER_GROUP_ENV]: '' })).toBe('group');
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
  test('installs its handlers while a child is live and removes them after', () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    expect(host.handlersInstalled).toBe(0);

    const releaseA = supervisor.adopt(new FakeChild('a', 101, true));
    const releaseB = supervisor.adopt(new FakeChild('b', 102, true));
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
    supervisor.adopt(grouped);
    supervisor.adopt(interactive);

    host.deliver('SIGTERM');

    expect(host.groupKills).toEqual([[101, 'SIGTERM']]);
    expect(grouped.signals).toEqual([]);
    expect(interactive.signals).toEqual(['SIGTERM']);
    expect(supervisor.cancelling).toBe(true);
    expect(host.reports.join('\n')).toContain('lane-group, lane-tty');

    grouped.exit();
    interactive.exit();
    await host.exited;
    expect(host.exitStatuses).toEqual([143]);
  });

  test('SIGINT is not repeated to a child that already got it from the terminal', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const grouped = new FakeChild('lane-group', 101, true);
    const interactive = new FakeChild('lane-tty', 102, false);
    supervisor.adopt(grouped);
    supervisor.adopt(interactive);

    host.deliver('SIGINT');

    expect(host.groupKills).toEqual([[101, 'SIGINT']]);
    expect(interactive.signals).toEqual([]);

    grouped.exit();
    interactive.exit();
    await host.exited;
    expect(host.exitStatuses).toEqual([130]);
  });

  test('a repeat of the signal inside the window is the same keypress', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const child = new FakeChild('lane', 101, true);
    supervisor.adopt(child);

    host.deliver('SIGINT');
    host.advance(200);
    host.deliver('SIGINT');

    expect(host.groupKills).toEqual([[101, 'SIGINT']]);
    child.exit();
    await host.exited;
    expect(host.exitStatuses).toEqual([130]);
  });

  test('kills what ignored the signal for the whole grace period', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const stubborn = new FakeChild('lane-stubborn', 101, true);
    supervisor.adopt(stubborn);

    host.deliver('SIGTERM');
    host.advance(CANCEL_GRACE_MS - 1);
    await settle();
    expect(host.groupKills).toEqual([[101, 'SIGTERM']]);

    host.advance(1);
    await settle();
    expect(host.groupKills).toEqual([
      [101, 'SIGTERM'],
      [101, 'SIGKILL'],
    ]);
    expect(host.reports.join('\n')).toContain('lane-stubborn');

    stubborn.exit();
    await host.exited;
    expect(host.exitStatuses).toEqual([143]);
  });

  test('a second signal after the window stops waiting and kills at once', async () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    supervisor.adopt(new FakeChild('lane', 101, true));

    host.deliver('SIGINT');
    host.advance(1_500);
    host.deliver('SIGINT');

    expect(host.groupKills).toEqual([
      [101, 'SIGINT'],
      [101, 'SIGKILL'],
    ]);
    await host.exited;
    expect(host.exitStatuses).toEqual([130]);
  });

  test('a runner that ends on its own takes live children down with SIGTERM', () => {
    const host = new FakeProcessHost();
    const supervisor = new ChildSupervisor(host);
    const grouped = new FakeChild('lane-group', 101, true);
    const interactive = new FakeChild('lane-tty', 102, false);
    supervisor.adopt(grouped);
    supervisor.adopt(interactive);

    host.endProcess();

    expect(host.groupKills).toEqual([[101, 'SIGTERM']]);
    expect(interactive.signals).toEqual(['SIGTERM']);
    expect(host.exitStatuses).toEqual([]);
  });
});
