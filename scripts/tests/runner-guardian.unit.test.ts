import { afterEach, describe, expect, test } from 'bun:test';

import {
  encodeDone,
  encodeStopping,
  encodeWatch,
  type GuardedChild,
  GUARDIAN_READY,
  type GuardianChannel,
  type GuardianHost,
  GuardianLedger,
  GuardianLink,
  LineBuffer,
  parseCommand,
  runGuardian,
  stopRegistered,
} from '../lib/runner-guardian';
import { isAlive } from './support/process-liveness';
import { forceKill, forceKillGroup, waitFor } from './support/process-tree';

// The pure parts of the guardian, pinned with named fakes: what the protocol
// accepts, what is signalled and in which order, and how the runner's side
// behaves when the guardian cannot start. Which processes really survive a
// SIGKILLed runner is covered with live processes in
// exec-process-tree.unit.test.ts; the last block here runs the real program.

const IS_WINDOWS = process.platform === 'win32';

/** A named stand-in for the machine: it records signals, and time moves only when slept. */
class FakeGuardianHost implements GuardianHost {
  readonly signals: string[] = [];
  /** Children that keep running through SIGTERM and only leave on SIGKILL. */
  readonly stubborn = new Set<number>();
  /** Children that leave on their own once the clock reaches the given millisecond. */
  readonly leaveAt = new Map<number, number>();
  /** Ids an unrelated process takes over once the clock reaches the given millisecond. */
  readonly reusedAt = new Map<number, number>();
  private readonly running = new Set<number>();
  private clock = 0;
  sleeps = 0;

  constructor(running: readonly GuardedChild[]) {
    for (const child of running) this.running.add(child.pid);
  }

  signal(child: GuardedChild, signal: NodeJS.Signals): void {
    this.signals.push(`${signal} ${child.kind} ${child.pid}`);
    if (signal === 'SIGKILL' || !this.stubborn.has(child.pid)) this.running.delete(child.pid);
  }

  alive(child: GuardedChild): boolean {
    if (this.now() >= (this.reusedAt.get(child.pid) ?? Infinity)) return true;
    return this.running.has(child.pid) && this.now() < (this.leaveAt.get(child.pid) ?? Infinity);
  }

  sleep(ms: number): Promise<void> {
    this.sleeps += 1;
    this.clock += ms;
    return Promise.resolve();
  }

  now(): number {
    return this.clock;
  }
}

/** A named stand-in for the runner's pipe end: it records lines, or fails on demand. */
class FakeGuardianChannel implements GuardianChannel {
  readonly lines: string[] = [];
  failWith: Error | undefined;

  send(line: string): void {
    if (this.failWith) throw this.failWith;
    this.lines.push(line);
  }
}

/** The bytes a pipe delivers, chunk by chunk, until it closes. */
function chunksOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

/** Fails with `(runner guardian): expected <what>: <expected> | received: <actual>`. */
function expectState(what: string, expected: unknown, actual: unknown): void {
  if (Object.is(expected, actual)) return;
  throw new Error(
    `(runner guardian): expected ${what}: ${String(expected)} | received: ${String(actual)}`
  );
}

/** The pid must stop running within `ms`; a survivor is named in the failure. */
async function expectGone(what: string, pid: number, ms = 2_000): Promise<void> {
  await waitFor(() => !isAlive(pid), ms);
  expectState(`${what} (pid ${pid}) running`, false, isAlive(pid));
}

const GROUP: GuardedChild = { kind: 'group', pid: 4001 };
const SINGLE: GuardedChild = { kind: 'pid', pid: 4002 };

describe('encodeWatch and encodeDone', () => {
  test('write one newline-terminated line each', () => {
    expect(encodeWatch(GROUP)).toBe('group 4001\n');
    expect(encodeWatch(SINGLE)).toBe('pid 4002\n');
    expect(encodeDone(4001)).toBe('done 4001\n');
  });

  test('are read back by parseCommand', () => {
    expect(parseCommand(encodeWatch(GROUP).trimEnd())).toEqual({ op: 'watch', child: GROUP });
    expect(parseCommand(encodeDone(4001).trimEnd())).toEqual({ op: 'done', pid: 4001 });
  });
});

describe('encodeStopping', () => {
  test('is one bare line, and parseCommand reads it back', () => {
    expect(encodeStopping()).toBe('stopping\n');
    expect(parseCommand('stopping')).toEqual({ op: 'stopping' });
  });

  test.each(['stopping 4001', 'Stopping', ' stopping', 'stopping '])(
    'rejects %j, which is not the bare line',
    (line) => {
      expect(parseCommand(line)).toBeUndefined();
    }
  );
});

describe('parseCommand', () => {
  test.each([
    ['', 'an empty line'],
    ['group', 'a command with no pid'],
    ['group 4001 extra', 'trailing text'],
    ['group  4001', 'two spaces'],
    ['kill 4001', 'an unknown command'],
    ['group -1', 'a negative pid'],
    ['group 1.5', 'a fractional pid'],
    ['group 0x10', 'a hex pid'],
    ['group 99999999999', 'a pid too long to be one'],
    ['GROUP 4001', 'the wrong case'],
  ])('rejects %j (%s)', (line) => {
    expect(parseCommand(line)).toBeUndefined();
  });

  // kill(-1) signals every process the user may signal, and kill(0) the caller's own group.
  test.each(['group 0', 'group 1', 'pid 0', 'pid 1', 'done 1'])(
    'refuses %j, a pid that is never a runner child',
    (line) => {
      expect(parseCommand(line)).toBeUndefined();
    }
  );

  test('accepts the lowest pid a child can have', () => {
    expect(parseCommand('group 2')).toEqual({ op: 'watch', child: { kind: 'group', pid: 2 } });
  });
});

describe('LineBuffer', () => {
  test('returns whole lines and holds the unfinished one back', () => {
    const lines = new LineBuffer();

    expect(lines.push('group 4')).toEqual([]);
    expect(lines.push('001\npid 4002\ndo')).toEqual(['group 4001', 'pid 4002']);
    expect(lines.push('ne 4001\n')).toEqual(['done 4001']);
  });

  test('never returns a fragment that no newline ended', () => {
    const lines = new LineBuffer();

    expect(lines.push('group 4001\ngroup 40')).toEqual(['group 4001']);
    expect(lines.push('')).toEqual([]);
  });
});

describe('GuardianLedger', () => {
  test('lists what is registered, in registration order', () => {
    const ledger = new GuardianLedger();
    ledger.apply('group 4001');
    ledger.apply('pid 4002');

    expect(ledger.entries()).toEqual([GROUP, SINGLE]);
  });

  test('drops a child on done', () => {
    const ledger = new GuardianLedger();
    ledger.apply('group 4001');
    ledger.apply('pid 4002');
    ledger.apply('done 4001');

    expect(ledger.entries()).toEqual([SINGLE]);
  });

  test('keeps one entry for a pid registered twice', () => {
    const ledger = new GuardianLedger();
    ledger.apply('group 4001');
    ledger.apply('group 4001');

    expect(ledger.entries()).toEqual([GROUP]);
  });

  test('marks the children registered before `stopping` as signalled, and only those', () => {
    const ledger = new GuardianLedger();
    ledger.apply('group 4001');
    expect([...ledger.signalled()]).toEqual([]);

    ledger.apply('stopping');
    ledger.apply('pid 4002');

    expect([...ledger.signalled()]).toEqual([4001]);
    expect(ledger.entries()).toEqual([GROUP, SINGLE]);
  });

  test('forgets a signalled child on done, and a re-registered pid is unsignalled again', () => {
    const ledger = new GuardianLedger();
    ledger.apply('group 4001');
    ledger.apply('pid 4002');
    ledger.apply('stopping');
    ledger.apply('done 4001');
    ledger.apply('pid 4002');

    expect([...ledger.signalled()]).toEqual([]);
    expect(ledger.entries()).toEqual([SINGLE]);
  });

  test('a `stopping` with nothing registered changes nothing', () => {
    const ledger = new GuardianLedger();
    ledger.apply('stopping');
    ledger.apply('group 4001');

    expect([...ledger.signalled()]).toEqual([]);
  });

  test('ignores a done for a pid it never saw, and lines that are not commands', () => {
    const ledger = new GuardianLedger();
    ledger.apply('done 4001');
    ledger.apply('group 1');
    ledger.apply('rm -rf');

    expect(ledger.entries()).toEqual([]);
  });
});

describe('stopRegistered', () => {
  test('SIGTERMs each child, a group by its group, and does not wait for ones that left', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);

    const killed = await stopRegistered([GROUP, SINGLE], host, 5_000);

    expect(host.signals).toEqual(['SIGTERM group 4001', 'SIGTERM pid 4002']);
    expect(killed).toEqual([]);
    expect(host.sleeps).toBe(0);
  });

  test('waits for a child that is still leaving and then sends no SIGKILL', async () => {
    const host = new FakeGuardianHost([GROUP]);
    host.stubborn.add(GROUP.pid);
    host.leaveAt.set(GROUP.pid, 100);

    const killed = await stopRegistered([GROUP], host, 5_000);

    expect(killed).toEqual([]);
    expect(host.signals).toEqual(['SIGTERM group 4001']);
    expect(host.now()).toBeGreaterThanOrEqual(100);
    expect(host.now()).toBeLessThan(5_000);
  });

  test('SIGKILLs only the children still running when the grace has passed', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);
    host.stubborn.add(GROUP.pid);

    const killed = await stopRegistered([GROUP, SINGLE], host, 5_000);

    expect(killed).toEqual([GROUP]);
    expect(host.signals).toEqual(['SIGTERM group 4001', 'SIGTERM pid 4002', 'SIGKILL group 4001']);
    expect(host.now()).toBeGreaterThanOrEqual(5_000);
  });

  test('never probes or signals a child again once it was seen gone', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);
    host.stubborn.add(SINGLE.pid);
    host.leaveAt.set(GROUP.pid, 100);
    // After the group left, an unrelated process takes its id before the grace ends.
    host.reusedAt.set(GROUP.pid, 3_000);

    const killed = await stopRegistered([GROUP, SINGLE], host, 5_000);

    expect(host.now()).toBeGreaterThanOrEqual(5_000);
    expect(killed).toEqual([SINGLE]);
    expect(host.signals).toEqual(['SIGTERM group 4001', 'SIGTERM pid 4002', 'SIGKILL pid 4002']);
  });

  test('sends no SIGTERM to a child the runner already signalled, and still SIGKILLs a survivor', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);
    host.stubborn.add(GROUP.pid);
    host.stubborn.add(SINGLE.pid);
    host.leaveAt.set(SINGLE.pid, 200);

    const killed = await stopRegistered([GROUP, SINGLE], host, 5_000, new Set([GROUP.pid]));

    // SINGLE was not signalled by the runner, so it gets its SIGTERM; GROUP only the SIGKILL.
    expect(host.signals).toEqual(['SIGTERM pid 4002', 'SIGKILL group 4001']);
    expect(killed).toEqual([GROUP]);
    expect(host.now()).toBeGreaterThanOrEqual(5_000);
  });

  test('signals nothing for signalled children that leave inside the grace', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);
    host.leaveAt.set(GROUP.pid, 100);
    host.leaveAt.set(SINGLE.pid, 150);

    const killed = await stopRegistered(
      [GROUP, SINGLE],
      host,
      5_000,
      new Set([GROUP.pid, SINGLE.pid])
    );

    expect(host.signals).toEqual([]);
    expect(killed).toEqual([]);
  });

  test('signals nothing when nothing is registered', async () => {
    const host = new FakeGuardianHost([]);

    expect(await stopRegistered([], host, 5_000)).toEqual([]);
    expect(host.signals).toEqual([]);
  });
});

describe('runGuardian', () => {
  test('stops what is registered when the input ends', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);

    await runGuardian(chunksOf('group 4001\npid 4002\n'), host, 5_000);

    expect(host.signals).toEqual(['SIGTERM group 4001', 'SIGTERM pid 4002']);
  });

  test('registers then deregisters a child: the normal-exit case leaves the host untouched', async () => {
    const host = new FakeGuardianHost([GROUP]);

    await runGuardian(chunksOf('group 4001\n', 'done 4001\n'), host, 5_000);

    expect(host.signals).toEqual([]);
  });

  test('after `stopping` sends no SIGTERM and SIGKILLs only what stays alive', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);
    host.stubborn.add(GROUP.pid);
    host.leaveAt.set(SINGLE.pid, 300);

    await runGuardian(chunksOf('group 4001\npid 4002\nstopping\n'), host, 5_000);

    expect(host.signals).toEqual(['SIGKILL group 4001']);
  });

  test('SIGTERMs a child registered after `stopping`, which nobody has signalled', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);
    host.leaveAt.set(GROUP.pid, 100);

    await runGuardian(chunksOf('group 4001\nstopping\npid 4002\n'), host, 5_000);

    expect(host.signals).toEqual(['SIGTERM pid 4002']);
  });

  test('reads a line split across chunks', async () => {
    const host = new FakeGuardianHost([GROUP]);

    await runGuardian(chunksOf('gro', 'up 40', '01\n'), host, 5_000);

    expect(host.signals).toEqual(['SIGTERM group 4001']);
  });

  test('ignores a registration the runner died in the middle of writing', async () => {
    const host = new FakeGuardianHost([GROUP, SINGLE]);

    await runGuardian(chunksOf('group 4001\npid 40'), host, 5_000);

    expect(host.signals).toEqual(['SIGTERM group 4001']);
  });

  test('signals nothing when the runner never registered anything', async () => {
    const host = new FakeGuardianHost([]);

    await runGuardian(chunksOf(), host, 5_000);

    expect(host.signals).toEqual([]);
  });
});

describe('GuardianLink', () => {
  const quiet = (): ((message: string) => void) & { readonly messages: string[] } => {
    const messages: string[] = [];
    return Object.assign((message: string) => void messages.push(message), { messages });
  };

  test('starts nothing until a child is opened or watched', () => {
    const channel = new FakeGuardianChannel();
    let launches = 0;
    const link = new GuardianLink(() => {
      launches += 1;
      return channel;
    }, quiet());

    expect(launches).toBe(0);
    expect(link.active).toBe(false);

    link.open();
    link.open();
    link.watch(GROUP);

    expect(launches).toBe(1);
    expect(link.active).toBe(true);
  });

  test('registers a child, and deregisters it once however often it is released', () => {
    const channel = new FakeGuardianChannel();
    const link = new GuardianLink(() => channel, quiet());

    const release = link.watch(GROUP);
    link.watch(SINGLE);
    release();
    release();

    expect(channel.lines).toEqual(['group 4001\n', 'pid 4002\n', 'done 4001\n']);
  });

  test('carries on without a guardian that cannot start, and says so once', () => {
    const report = quiet();
    const link = new GuardianLink(() => {
      throw new Error('spawn bun ENOENT');
    }, report);

    const release = link.watch(GROUP);
    link.watch(SINGLE);
    release();

    expect(link.active).toBe(false);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0]).toContain('spawn bun ENOENT');
    expect(report.messages[0]).toContain('could not start');
  });

  test('carries on without a guardian that stops answering, and says so once', () => {
    const channel = new FakeGuardianChannel();
    const report = quiet();
    const link = new GuardianLink(() => channel, report);
    link.watch(GROUP);

    channel.failWith = new Error('EPIPE');
    link.watch(SINGLE);
    link.watch({ kind: 'pid', pid: 4003 });

    expect(link.active).toBe(false);
    expect(channel.lines).toEqual(['group 4001\n']);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0]).toContain('stopped answering (EPIPE)');
  });

  test('says stopping through the channel, and says nothing before a guardian exists', () => {
    const channel = new FakeGuardianChannel();
    const link = new GuardianLink(() => channel, quiet());

    link.stopping();
    expect(channel.lines).toEqual([]);

    link.open();
    link.stopping();
    expect(channel.lines).toEqual(['stopping\n']);
  });

  test('stopping never throws, even when the guardian is gone or the report fails', () => {
    const channel = new FakeGuardianChannel();
    const link = new GuardianLink(
      () => channel,
      () => {
        throw new Error('stderr is hung up');
      }
    );
    link.open();
    channel.failWith = new Error('EPIPE');

    expect(() => link.stopping()).not.toThrow();
    expect(link.active).toBe(false);
  });

  test('does not launch a second guardian after the first failed', () => {
    let launches = 0;
    const link = new GuardianLink(() => {
      launches += 1;
      throw new Error('boom');
    }, quiet());

    link.open();
    link.open();
    link.watch(GROUP);

    expect(launches).toBe(1);
  });
});

// The real program, driven over its pipe: what the runner's side would write.
describe.skipIf(IS_WINDOWS)('the guardian program', () => {
  const GUARDIAN = `${import.meta.dir}/../lib/runner-guardian.ts`;
  const started: Array<{ kill(signal?: NodeJS.Signals): void; readonly pid: number }> = [];

  afterEach(() => {
    for (const process of started.splice(0)) forceKill(process.pid);
  });

  /** A stand-in for a runner's child: a process of the test's own that does nothing. */
  function startBystander(detached: boolean) {
    const bystander = Bun.spawn(['sleep', '60'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached,
    });
    started.push(bystander);
    return bystander;
  }

  function startGuardian(graceMs: number) {
    const guardian = Bun.spawn([process.execPath, GUARDIAN, String(process.pid), String(graceMs)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    started.push(guardian);
    return guardian;
  }

  /** Waits for the line that says the guardian ignores the cancelling signals. */
  async function untilReady(guardian: ReturnType<typeof startGuardian>): Promise<void> {
    const reader = guardian.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    expectState('first line of the guardian', GUARDIAN_READY, first.trim());
  }

  /** Closes the runner's end, as a SIGKILLed runner does. */
  async function hangUp(guardian: ReturnType<typeof startGuardian>, ...lines: string[]) {
    for (const line of lines) void guardian.stdin.write(line);
    await guardian.stdin.end();
  }

  test('stops a registered group on EOF, and itself exits 0', async () => {
    const bystander = startBystander(true);
    const guardian = startGuardian(2_000);

    await hangUp(guardian, encodeWatch({ kind: 'group', pid: bystander.pid }));

    expectState('guardian exit status', 0, await guardian.exited);
    await expectGone('registered bystander', bystander.pid);
  });

  test('stops a registered pid on EOF', async () => {
    const bystander = startBystander(false);
    const guardian = startGuardian(2_000);

    await hangUp(guardian, encodeWatch({ kind: 'pid', pid: bystander.pid }));

    expectState('guardian exit status', 0, await guardian.exited);
    await expectGone('registered bystander', bystander.pid);
  });

  test('leaves a deregistered child alone and exits at once', async () => {
    const bystander = startBystander(true);
    const guardian = startGuardian(2_000);

    await hangUp(
      guardian,
      encodeWatch({ kind: 'group', pid: bystander.pid }),
      encodeDone(bystander.pid)
    );

    expectState('guardian exit status', 0, await guardian.exited);
    expectState(
      `deregistered bystander (pid ${bystander.pid}) running`,
      true,
      isAlive(bystander.pid)
    );
    forceKillGroup(bystander.pid);
  });

  test('keeps running through SIGINT, SIGTERM and SIGHUP while its pipe is open', async () => {
    const bystander = startBystander(true);
    const guardian = startGuardian(2_000);
    await untilReady(guardian);
    void guardian.stdin.write(encodeWatch({ kind: 'group', pid: bystander.pid }));
    void guardian.stdin.flush();

    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) guardian.kill(name);
    await Bun.sleep(300);
    expectState(
      `guardian (pid ${guardian.pid}) running after SIGINT, SIGTERM, SIGHUP`,
      true,
      isAlive(guardian.pid)
    );

    await guardian.stdin.end();
    expectState('guardian exit status', 0, await guardian.exited);
    await expectGone('registered bystander', bystander.pid);
  });

  test('refuses a grace that is not a number of milliseconds', async () => {
    const guardian = Bun.spawn([process.execPath, GUARDIAN, String(process.pid), 'soon'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    started.push(guardian);

    expect(await guardian.exited).not.toBe(0);
    expect(await new Response(guardian.stderr).text()).toContain(
      '(runner guardian): expected grace in ms | received: soon'
    );
  });
});
