import { describe, expect, test } from 'bun:test';

import {
  assertDrainPipeHolder,
  createDrainFixture,
  DRAIN_CHANNEL_ENV,
  type DrainFixtureActions,
  type DrainFixtureOwner,
  type LiveDrainFixture,
  startDrainPipeHolder,
  withOwnedDrainFixture,
} from './support/worker-drain-fixture';

class FakeNativeDrainReader {
  readonly observations: number[] = [];

  constructor(readonly alive: boolean) {}

  readonly read = (pid: number): boolean => {
    this.observations.push(pid);
    return this.alive;
  };
}

describe('drain pipe-holder observations', () => {
  test('accepts a live native PID with its retained channel', () => {
    const native = new FakeNativeDrainReader(true);
    assertDrainPipeHolder(4242, true, native.read);
    expect(native.observations).toEqual([4242]);
  });

  test('rejects an absent channel even while the native PID is alive', () => {
    const native = new FakeNativeDrainReader(true);
    expect(() => assertDrainPipeHolder(4242, false, native.read)).toThrow(
      'drain fixture PID 4242: expected holding pipes: true | received false'
    );
    expect(native.observations).toEqual([]);
  });

  test('rejects a stale live channel when the native PID is absent', () => {
    const native = new FakeNativeDrainReader(false);
    expect(() => assertDrainPipeHolder(4242, true, native.read)).toThrow(
      'drain fixture PID 4242: expected native process alive: true | received false'
    );
    expect(native.observations).toEqual([4242]);
  });
});

/** An owned pipe-holder and an unrelated process that reused a metadata PID. */
class FakeDrainOwner implements DrainFixtureOwner {
  ownedAlive = true;
  unrelatedAlive = true;
  closeCalls = 0;

  constructor(readonly closeFailure?: Error) {}

  close(): Promise<void> {
    this.closeCalls++;
    if (this.closeFailure) return Promise.reject(this.closeFailure);
    this.ownedAlive = false;
    return Promise.resolve();
  }
}

/** Named lane/metadata I/O fake; its legacy signal trap never signals the OS. */
class FakeDrainActions implements DrainFixtureActions<string, string> {
  readonly signals: number[] = [];

  constructor(
    readonly owner: FakeDrainOwner,
    readonly readFailure?: Error,
    readonly startFailure?: Error,
    readonly checkFailure?: Error
  ) {}

  readonly start = (): Promise<string> =>
    this.startFailure ? Promise.reject(this.startFailure) : Promise.resolve('ready lane');

  readonly readPid = (): number => {
    if (this.readFailure) throw this.readFailure;
    return 4242;
  };

  readonly check = (): string => {
    if (this.checkFailure) throw this.checkFailure;
    return 'checked lane';
  };

  readonly signalPid = (pid: number): void => {
    this.signals.push(pid);
    if (pid === 4242) this.owner.unrelatedAlive = false;
  };
}

describe('owned worker drain fixture', () => {
  test('settles the owned pipe-holder when its PID observation fails', async () => {
    const owner = new FakeDrainOwner();
    const failure = new Error('grandchild-1.pid: expected readable PID metadata | received ENOENT');
    const actions = new FakeDrainActions(owner, failure);
    const error = await withOwnedDrainFixture(owner, actions).catch((caught) => caught);

    expect(error).toBe(failure);
    expect(owner.ownedAlive, 'expected owned pipe-holders after PID-read failure: 0').toBe(false);
    expect(owner.closeCalls).toBe(1);
    expect(actions.signals).toEqual([]);
    expect(owner.unrelatedAlive).toBe(true);
  });

  test('never signals a reused metadata PID during cleanup', async () => {
    const owner = new FakeDrainOwner();
    const actions = new FakeDrainActions(owner);

    expect(await withOwnedDrainFixture(owner, actions)).toBe('checked lane');
    expect(actions.signals, 'expected signals to metadata PIDs: none').toEqual([]);
    expect(owner.ownedAlive).toBe(false);
    expect(owner.unrelatedAlive, 'expected unrelated PID 4242 to remain alive').toBe(true);
    expect(owner.closeCalls).toBe(1);
  });

  test('settles the owned pipe-holder when lane readiness fails', async () => {
    const owner = new FakeDrainOwner();
    const failure = new Error('controlled lane readiness failure');
    const actions = new FakeDrainActions(owner, undefined, failure);
    const error = await withOwnedDrainFixture(owner, actions).catch((caught) => caught);

    expect(error).toBe(failure);
    expect(owner.ownedAlive, 'expected owned pipe-holders after readiness failure: 0').toBe(false);
    expect(owner.closeCalls).toBe(1);
    expect(actions.signals).toEqual([]);
  });

  test('retains an assertion failure after owned cleanup', async () => {
    const owner = new FakeDrainOwner();
    const failure = new Error('controlled drain assertion failure');
    const actions = new FakeDrainActions(owner, undefined, undefined, failure);

    expect(await withOwnedDrainFixture(owner, actions).catch((caught) => caught)).toBe(failure);
    expect(owner.ownedAlive).toBe(false);
    expect(actions.signals).toEqual([]);
  });

  test('preserves primary and cleanup errors when settlement fails', async () => {
    const primary = new Error('controlled unreadable PID file');
    const cleanup = new Error('controlled drain channel failed to settle');
    const owner = new FakeDrainOwner(cleanup);
    const actions = new FakeDrainActions(owner, primary);
    const error = await withOwnedDrainFixture(owner, actions).catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([primary, cleanup]);
    expect(error.cause).toBe(primary);
    expect(owner.closeCalls).toBe(1);
    expect(actions.signals).toEqual([]);
  });

  test('rejects failed cleanup even when observations succeeded', async () => {
    const cleanup = new Error('controlled drain channel failed to settle');
    const owner = new FakeDrainOwner(cleanup);

    expect(
      await withOwnedDrainFixture(owner, new FakeDrainActions(owner)).catch((caught) => caught)
    ).toBe(cleanup);
  });
});

/** Only actual retained child handles may be used for this real control's emergency cleanup. */
class OwnedDrainChildren {
  readonly children: Bun.Subprocess[] = [];
  readonly track = (child: Bun.Subprocess): void => {
    this.children.push(child);
  };

  async wait(): Promise<number[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all(this.children.map((child) => child.exited)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('owned drain children: expected exit observations within 2000ms')),
            2_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    for (const child of this.children) if (child.exitCode === null) child.kill('SIGKILL');
    await this.wait();
  }
}

/** Real startup with a named failing PID observation; no metadata PID controls cleanup. */
class RealDrainActions implements DrainFixtureActions<Bun.Subprocess, number> {
  constructor(
    readonly owner: LiveDrainFixture,
    readonly children: OwnedDrainChildren,
    readonly readFailure?: Error
  ) {}

  readonly start = () =>
    startDrainPipeHolder({
      env: { ...process.env, ...this.owner.env },
      onStarted: this.children.track,
    });

  readonly readPid = (child: Bun.Subprocess): number => {
    if (this.readFailure) throw this.readFailure;
    return child.pid;
  };

  readonly check = async (child: Bun.Subprocess, observedPid: number): Promise<number> => {
    expect(await this.owner.ready()).toBe(child.pid);
    expect(observedPid).toBe(child.pid);
    expect(this.owner.holdingPipes).toBe(true);
    return child.pid;
  };
}

describe('retained cooperative drain connection', () => {
  test('rejects missing channel authority before spawning a child', async () => {
    const children = new OwnedDrainChildren();
    await expect(startDrainPipeHolder({ env: {}, onStarted: children.track })).rejects.toThrow(
      `${DRAIN_CHANNEL_ENV}: expected port and private token | received undefined`
    );
    expect(children.children).toEqual([]);
  });

  test('settles its connection, listener and real owned child', async () => {
    const owner = await createDrainFixture();
    const children = new OwnedDrainChildren();
    try {
      expect(await withOwnedDrainFixture(owner, new RealDrainActions(owner, children))).toBe(
        children.children[0]?.pid
      );
      expect(await children.wait()).toEqual([0]);
      expect(owner.settled).toBe(true);
      expect(owner.holdingPipes).toBe(false);
      await owner.close();
    } finally {
      await children.stop();
      await owner.close();
    }
  });

  test('settles the real owned child when the PID read fails', async () => {
    const owner = await createDrainFixture();
    const children = new OwnedDrainChildren();
    const failure = new Error('controlled grandchild-1.pid read failed');
    try {
      const error = await withOwnedDrainFixture(
        owner,
        new RealDrainActions(owner, children, failure)
      ).catch((caught) => caught);
      expect(error).toBe(failure);
      expect(await children.wait()).toEqual([0]);
      expect(owner.settled).toBe(true);
    } finally {
      await children.stop();
      await owner.close();
    }
  });

  test('bounds missing readiness and refuses observations after cleanup', async () => {
    const owner = await createDrainFixture(25);
    try {
      await expect(owner.ready()).rejects.toThrow(
        'drain fixture readiness: expected settlement within 25ms'
      );
    } finally {
      await owner.close();
    }
    expect(owner.settled).toBe(true);
    await expect(owner.ready()).rejects.toThrow('readiness requested after cleanup');
  });

  test('refuses late child startup after the listener closes and settles its handle', async () => {
    const owner = await createDrainFixture();
    const children = new OwnedDrainChildren();
    await owner.close();
    try {
      await expect(
        startDrainPipeHolder({ env: { ...process.env, ...owner.env }, onStarted: children.track })
      ).rejects.toThrow('expected readiness | received exit 1');
      expect(await children.wait()).toEqual([1]);
      expect(owner.settled).toBe(true);
    } finally {
      await children.stop();
    }
  });

  test('rejects an unowned token and leaves no retained connection behind', async () => {
    const owner = await createDrainFixture();
    const children = new OwnedDrainChildren();
    const port = owner.env[DRAIN_CHANNEL_ENV]?.split(' ')[0];
    try {
      await expect(
        startDrainPipeHolder({
          env: { ...process.env, [DRAIN_CHANNEL_ENV]: `${port} unrelated-token` },
          onStarted: children.track,
        })
      ).rejects.toThrow('expected readiness | received exit 1');
      expect(await children.wait()).toEqual([1]);
      expect(owner.holdingPipes).toBe(false);
    } finally {
      await children.stop();
      await owner.close();
    }
    expect(owner.settled).toBe(true);
  });

  test('refuses a second pipe-holder without replacing the retained connection', async () => {
    const owner = await createDrainFixture();
    const children = new OwnedDrainChildren();
    try {
      const first = await startDrainPipeHolder({
        env: { ...process.env, ...owner.env },
        onStarted: children.track,
      });
      await expect(
        startDrainPipeHolder({ env: { ...process.env, ...owner.env }, onStarted: children.track })
      ).rejects.toThrow('expected readiness | received exit 1');
      expect(await owner.ready()).toBe(first.pid);
      expect(first.exitCode).toBeNull();
      expect(owner.holdingPipes).toBe(true);
      await owner.close();
      expect(await children.wait()).toEqual([0, 1]);
      expect(owner.settled).toBe(true);
    } finally {
      await children.stop();
      await owner.close();
    }
  });
});
