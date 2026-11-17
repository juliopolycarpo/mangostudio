import { describe, expect, it } from 'bun:test';

import {
  findLeftovers,
  killProcessGroup,
  type Leftover,
  noteWorkerPausers,
  PODMAN_PAUSE_COMMAND,
  type ProcessEntry,
  type ProcessTable,
  settleWorker,
  signalWorker,
  sweepWorker,
  WORKER_TOKEN_ENV,
  type WorkerIdentity,
} from '../lib/test-worker-settle';

const entry = (overrides: Partial<ProcessEntry> & Pick<ProcessEntry, 'pid'>): ProcessEntry => ({
  pgid: 1,
  state: 'S',
  command: 'unrelated',
  ...overrides,
});

const WHO: WorkerIdentity = { pgid: 4000, token: 'worker-2-token' };

/** Records signal delivery and can model a vanished group or an unreadable table. */
class SignalHost {
  readonly sent: { pid: number; signal: NodeJS.Signals }[] = [];
  reads = 0;
  groupVanished = false;
  unreadable = false;

  constructor(readonly entries: readonly ProcessEntry[]) {}

  readonly table: ProcessTable = () => {
    this.reads += 1;
    if (this.unreadable) throw new Error('ps: exit 1');
    return this.entries;
  };

  readonly sendSignal = (pid: number, signal: NodeJS.Signals): void => {
    this.sent.push({ pid, signal });
    if (pid < 0 && this.groupVanished) throw new Error('group already gone');
  };
}

describe('signalWorker', () => {
  it('signals the group once and only live escaped children with its exact token', () => {
    const host = new SignalHost([
      entry({ pid: 4100, pgid: 4000, environ: `${WORKER_TOKEN_ENV}=${WHO.token}` }),
      entry({ pid: 4200, pgid: 4200, environ: `${WORKER_TOKEN_ENV}=sibling-token` }),
      entry({ pid: 4300, pgid: 4300, environ: `${WORKER_TOKEN_ENV}=${WHO.token}` }),
      entry({ pid: 4400, pgid: 4400, environ: `${WORKER_TOKEN_ENV}=${WHO.token}-extra` }),
      entry({ pid: 4500, pgid: 4500, state: 'Z', environ: `${WORKER_TOKEN_ENV}=${WHO.token}` }),
    ]);
    signalWorker(WHO, 'SIGTERM', host);
    expect(host.sent).toEqual([
      { pid: -4000, signal: 'SIGTERM' },
      { pid: 4300, signal: 'SIGTERM' },
    ]);
  });

  it('still signals an escaped child when the group has already gone', () => {
    const host = new SignalHost([
      entry({ pid: 4300, pgid: 4300, environ: `${WORKER_TOKEN_ENV}=${WHO.token}` }),
    ]);
    host.groupVanished = true;
    signalWorker(WHO, 'SIGKILL', host);
    expect(host.sent).toEqual([
      { pid: -4000, signal: 'SIGKILL' },
      { pid: 4300, signal: 'SIGKILL' },
    ]);
  });

  it('signals only token members when there is no group', () => {
    const host = new SignalHost([
      entry({ pid: 4300, pgid: 4300, environ: `${WORKER_TOKEN_ENV}=${WHO.token}` }),
    ]);
    signalWorker({ ...WHO, pgid: null }, 'SIGTERM', host);
    expect(host.sent).toEqual([{ pid: 4300, signal: 'SIGTERM' }]);
  });

  it('signals only the group when no token is available', () => {
    const host = new SignalHost([]);
    host.unreadable = true;
    signalWorker({ ...WHO, token: '' }, 'SIGKILL', host);
    expect(host.sent).toEqual([{ pid: -4000, signal: 'SIGKILL' }]);
    expect(host.reads).toBe(0);
  });

  it('reports an unreadable table after delivering the group signal', () => {
    const host = new SignalHost([]);
    host.unreadable = true;
    expect(() => signalWorker(WHO, 'SIGTERM', host)).toThrow('ps: exit 1');
    expect(host.sent).toEqual([{ pid: -4000, signal: 'SIGTERM' }]);
  });
});

describe('findLeftovers', () => {
  it('finds a process in the worker’s group', () => {
    const entries = [
      entry({ pid: 4100, pgid: 4000, command: 'sleep 600' }),
      entry({ pid: 4200, pgid: 5000, command: 'a sibling worker’s child' }),
    ];
    expect(findLeftovers(entries, WHO)).toEqual([{ pid: 4100, command: 'sleep 600' }]);
  });

  it('finds a process that left the group but kept the worker’s environment', () => {
    const entries = [
      entry({
        pid: 4300,
        pgid: 4300,
        command: 'mangostudio-runtime serve',
        environ: `HOME=/tmp/x\n${WORKER_TOKEN_ENV}=worker-2-token\nPATH=/bin`,
      }),
      entry({
        pid: 4400,
        pgid: 4400,
        command: 'another worker’s runtime',
        environ: `${WORKER_TOKEN_ENV}=worker-3-token`,
      }),
    ];
    expect(findLeftovers(entries, WHO).map((found) => found.pid)).toEqual([4300]);
  });

  it('does not take a token that merely starts with the worker’s', () => {
    const entries = [entry({ pid: 4500, environ: `${WORKER_TOKEN_ENV}=worker-2-token-extra` })];
    expect(findLeftovers(entries, WHO)).toEqual([]);
  });

  it('ignores a zombie: it holds a table slot, not a port or a lock', () => {
    expect(findLeftovers([entry({ pid: 4100, pgid: 4000, state: 'Z' })], WHO)).toEqual([]);
  });

  it('looks only by token for a worker that leads no group', () => {
    const entries = [entry({ pid: 4100, pgid: 4000 })];
    expect(findLeftovers(entries, { pgid: null, token: 'worker-2-token' })).toEqual([]);
  });
});

describe('settleWorker', () => {
  /** A table whose group empties after `drainsAfter` reads, as a runtime child shutting down does. */
  const draining = (drainsAfter: number): { table: ProcessTable; reads: () => number } => {
    let reads = 0;
    return {
      table: () => {
        reads += 1;
        return reads > drainsAfter ? [] : [entry({ pid: 4100, pgid: 4000, command: 'sleep 1' })];
      },
      reads: () => reads,
    };
  };
  const instantly = (): Promise<void> => Promise.resolve();

  it('waits for a descendant that is on its way out, and reports nothing', async () => {
    const { table } = draining(3);
    const reaped: Leftover[][] = [];
    const leftovers = await settleWorker({
      who: WHO,
      table,
      sleep: instantly,
      reap: (found) => reaped.push([...found]),
    });
    expect(leftovers).toEqual([]);
    expect(reaped).toEqual([]);
  });

  it('reports, and kills, a descendant still running after the grace', async () => {
    const stubborn: ProcessTable = () => [entry({ pid: 4100, pgid: 4000, command: 'sleep 600' })];
    const reaped: { found: Leftover[]; who: WorkerIdentity }[] = [];
    const leftovers = await settleWorker({
      who: WHO,
      table: stubborn,
      graceMs: 200,
      pollMs: 50,
      sleep: instantly,
      reap: (found, who) => reaped.push({ found: [...found], who }),
    });
    expect(leftovers).toEqual([{ pid: 4100, command: 'sleep 600' }]);
    expect(reaped).toEqual([{ found: [{ pid: 4100, command: 'sleep 600' }], who: WHO }]);
  });

  it('does not wait at all for a worker that left nothing', async () => {
    const { table, reads } = draining(0);
    expect(await settleWorker({ who: WHO, table, sleep: instantly })).toEqual([]);
    expect(reads()).toBe(1);
  });

  it('lets a table that cannot be read fail the check instead of passing it', async () => {
    const unreadable: ProcessTable = () => {
      throw new Error('ps: exit 1');
    };
    await expect(settleWorker({ who: WHO, table: unreadable })).rejects.toThrow('ps: exit 1');
  });
});

describe('killProcessGroup', () => {
  it('signals the negated group id', () => {
    const host = new SignalHost([]);
    killProcessGroup(4000, 'SIGKILL', host.sendSignal);
    expect(host.sent).toEqual([{ pid: -4000, signal: 'SIGKILL' }]);
  });

  it('treats a group that has already emptied as done', () => {
    const host = new SignalHost([]);
    host.groupVanished = true;
    expect(() => killProcessGroup(4000, 'SIGTERM', host.sendSignal)).not.toThrow();
  });

  // In Bun `kill(0)`, `kill(-0)` and `kill('')` (Number('') is 0) signal the caller's own group,
  // and `kill(-1)` reaches every process of the user.
  it.each([0, -0, 1, -1, 1.5, Number.NaN, Number(''), Number.POSITIVE_INFINITY])(
    'refuses %p without sending anything',
    (pgid) => {
      const host = new SignalHost([]);
      expect(() => killProcessGroup(pgid, 'SIGKILL', host.sendSignal)).toThrow(
        'expected worker pid: integer > 1 | received:'
      );
      expect(host.sent).toEqual([]);
    }
  );

  it('is what signalWorker uses, so a worker with a bad group id signals no group', () => {
    const host = new SignalHost([]);
    expect(() => signalWorker({ pgid: 0, token: '' }, 'SIGTERM', host)).toThrow('received: 0');
    expect(host.sent).toEqual([]);
  });
});

describe('sweepWorker', () => {
  const TOKEN_ENV = `${WORKER_TOKEN_ENV}=${WHO.token}`;
  const sweep = (host: SignalHost) =>
    sweepWorker(WHO, { table: host.table, sendSignal: host.sendSignal, label: 'w2' });

  it('signals nothing for an empty group', () => {
    const host = new SignalHost([entry({ pid: 9000, pgid: 9000, environ: 'A=1' })]);
    expect(sweep(host)).toEqual([]);
    expect(host.sent).toEqual([]);
  });

  it('signals nothing to a group a tokenless stranger holds, and notes it', () => {
    const host = new SignalHost([entry({ pid: 4000, pgid: 4000, command: 'job', environ: 'A=1' })]);
    expect(sweep(host)).toEqual([
      "w2: group 4000 is held by 1 process(es) without the worker's token (pid 4000); nothing signalled",
    ]);
    expect(host.sent).toEqual([]);
  });

  it('SIGKILLs the group when a token-carrying survivor is in it, and escaped carriers by pid', () => {
    const host = new SignalHost([
      entry({ pid: 4100, pgid: 4000, environ: TOKEN_ENV }),
      entry({ pid: 4200, pgid: 4200, environ: TOKEN_ENV }),
      entry({ pid: 4300, pgid: 4300, environ: 'A=1' }),
    ]);
    sweep(host);
    expect(host.sent).toEqual([
      { pid: -4000, signal: 'SIGKILL' },
      { pid: 4200, signal: 'SIGKILL' },
    ]);
  });

  it('trusts the group alone where the table cannot read any environment (ps)', () => {
    const host = new SignalHost([entry({ pid: 4100, pgid: 4000 })]);
    sweep(host);
    expect(host.sent).toEqual([{ pid: -4000, signal: 'SIGKILL' }]);
  });

  it('lets the group alone decide for a caller that has no token', () => {
    const host = new SignalHost([entry({ pid: 4100, pgid: 4000, environ: 'A=1' })]);
    sweepWorker(
      { pgid: 4000, token: '' },
      { table: host.table, sendSignal: host.sendSignal, label: 'w' }
    );
    expect(host.sent).toEqual([{ pid: -4000, signal: 'SIGKILL' }]);
  });

  it('refuses a worker pid that is no group id before reading the table', () => {
    const host = new SignalHost([]);
    expect(() => sweepWorker({ pgid: 1, token: 't' }, { table: host.table, label: 'w' })).toThrow(
      'expected worker pid: integer > 1 | received: 1'
    );
    expect(host.reads).toBe(0);
  });

  it('spares a group holding a podman pause process and kills its token-carrying members by pid', () => {
    const host = new SignalHost([
      entry({
        pid: 4050,
        pgid: 4000,
        sid: 4000,
        startedAt: '5',
        command: PODMAN_PAUSE_COMMAND,
        environ: `PWD=/w\n${TOKEN_ENV}`,
      }),
      entry({ pid: 4100, pgid: 4000, environ: TOKEN_ENV }),
    ]);
    const notes = sweep(host);
    expect(host.sent).toEqual([{ pid: 4100, signal: 'SIGKILL' }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('shares worker group: true, session: true');
    expect(notes[0]).toContain('group SIGKILL skipped, members killed by pid');
  });

  it('signals the group as usual when the pause process lives outside it, and still names it', () => {
    const host = new SignalHost([
      entry({ pid: 4100, pgid: 4000, environ: TOKEN_ENV }),
      entry({ pid: 7000, pgid: 7000, command: PODMAN_PAUSE_COMMAND, environ: TOKEN_ENV }),
    ]);
    const notes = sweep(host);
    expect(host.sent).toEqual([{ pid: -4000, signal: 'SIGKILL' }]);
    expect(notes[0]).toContain('pid 7000 pgid 7000');
    expect(notes[0]).toContain('shares worker group: false');
  });
});

describe('noteWorkerPausers', () => {
  it('names a pause process carrying the token and signals nothing', () => {
    const host = new SignalHost([
      entry({
        pid: 7100,
        pgid: 7100,
        command: PODMAN_PAUSE_COMMAND,
        environ: `PWD=/w\nSECRET=x\n${WORKER_TOKEN_ENV}=${WHO.token}`,
      }),
    ]);
    const notes = noteWorkerPausers(WHO, { table: host.table, label: 'w2' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('PWD=/w');
    expect(notes[0]).not.toContain('SECRET');
    expect(host.sent).toEqual([]);
  });
});

describe('podman’s rootless pause process', () => {
  it('is not a leftover even when it carries the worker’s token', () => {
    const environ = `${WORKER_TOKEN_ENV}=${WHO.token}`;
    const entries = [
      entry({ pid: 4100, pgid: 4000, command: PODMAN_PAUSE_COMMAND, environ }),
      entry({ pid: 4200, pgid: 4200, command: PODMAN_PAUSE_COMMAND, environ }),
    ];
    expect(findLeftovers(entries, WHO)).toEqual([]);
  });

  it('is not signalled by token either', () => {
    const host = new SignalHost([
      entry({
        pid: 4300,
        pgid: 4300,
        command: PODMAN_PAUSE_COMMAND,
        environ: `${WORKER_TOKEN_ENV}=${WHO.token}`,
      }),
    ]);
    signalWorker(WHO, 'SIGKILL', host);
    expect(host.sent).toEqual([{ pid: -4000, signal: 'SIGKILL' }]);
  });

  it('exempts only the exact command line, never a similar one', () => {
    const environ = `${WORKER_TOKEN_ENV}=${WHO.token}`;
    const similar = ['catatonit -P --extra', '/usr/bin/catatonit -P', 'catatonit', 'sleep 600'];
    const entries = similar.map((command, offset) =>
      entry({ pid: 4400 + offset, pgid: 4400 + offset, command, environ })
    );
    expect(findLeftovers(entries, WHO).map((leftover) => leftover.command)).toEqual(similar);
  });
});
