import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { FixtureCommands } from './support/fixture-command';
import {
  assertDrainPipeHolder,
  createDrainFixture,
  DRAIN_CHANNEL_ENV,
  type DrainFixtureActions,
  type DrainFixtureOwner,
  DrainFixtureScope,
  type LiveDrainFixture,
  startDrainPipeHolder,
  withOwnedDrainFixture,
} from './support/worker-drain-fixture';
import type { WorkerDrainLifecycleEvent } from './support/worker-drain-lifecycle.fixture';

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

/** A named channel fake whose native lifetime is controlled independently. */
class ControlledScopeFixture implements LiveDrainFixture {
  readonly env = {};
  holdingPipes = true;
  settled = false;
  nativePid: number | undefined = 4242;
  closeCalls = 0;
  readonly closeObserved = Promise.withResolvers<void>();
  close(): Promise<void> {
    this.closeCalls += 1;
    this.holdingPipes = false;
    this.settled = true;
    this.closeObserved.resolve();
    return Promise.resolve();
  }
  ready(): Promise<number> {
    return Promise.resolve(this.nativePid ?? 0);
  }
}

/** Controls allocation, native observations and time without signaling any PID. */
class ControlledScopeHost {
  readonly fixture = new ControlledScopeFixture();
  readonly allocation = Promise.withResolvers<LiveDrainFixture>();
  readonly observations: Array<[number, number]> = [];
  states: Array<boolean | Error> = [];
  time = 0;
  create = () => this.allocation.promise;
  readNativeAlive = (pid: number, timeoutMs: number): Promise<boolean> => {
    this.observations.push([pid, timeoutMs]);
    const state = this.states.shift() ?? true;
    return state instanceof Error ? Promise.reject(state) : Promise.resolve(state);
  };
  now = () => this.time;
  pause = (ms: number) => {
    this.time += ms;
    return Promise.resolve();
  };
}

describe('drain fixture timeout ownership', () => {
  test('closes a late allocation and prevents its callback from continuing', async () => {
    const controller = new AbortController();
    const host = new ControlledScopeHost();
    const scope = new DrainFixtureScope(controller.signal, host, 100);
    const allocation = scope.allocate().catch((error: unknown) => error);
    controller.abort();
    host.allocation.resolve(host.fixture);
    expect(await allocation).toBe(controller.signal.reason);
    await scope.closed;
    expect(host.fixture.closeCalls).toBe(1);
    expect(host.observations).toEqual([]);
  });

  test('retains uncertainty when the channel closes while the authenticated process stays alive', async () => {
    const controller = new AbortController();
    const host = new ControlledScopeHost();
    const scope = new DrainFixtureScope(controller.signal, host, 100);
    host.allocation.resolve(host.fixture);
    await scope.allocate();
    scope.markLaneStarted();
    await expect(scope.close()).rejects.toThrow('expected native exit within 100ms');
    expect(host.fixture.settled).toBe(true);
    expect(host.observations.length).toBeGreaterThan(0);
    expect(host.observations.every(([pid]) => pid === 4242)).toBe(true);
  });

  test('preserves native query failures instead of reporting absence', async () => {
    const host = new ControlledScopeHost();
    const failure = new Error('named native query refusal');
    host.states.push(failure);
    host.allocation.resolve(host.fixture);
    const scope = new DrainFixtureScope(new AbortController().signal, host, 100);
    await scope.allocate();
    scope.markLaneStarted();
    expect(await scope.close().catch((error: unknown) => error)).toBe(failure);
    expect(host.observations).toEqual([[4242, 100]]);
  });

  test('bounds a native query that does not settle and never infers absence', async () => {
    const host = new ControlledScopeHost();
    const held = Promise.withResolvers<boolean>();
    host.readNativeAlive = (pid, timeoutMs) => {
      host.observations.push([pid, timeoutMs]);
      return held.promise;
    };
    host.allocation.resolve(host.fixture);
    const scope = new DrainFixtureScope(new AbortController().signal, host, 25);
    await scope.allocate();
    scope.markLaneStarted();
    try {
      await expect(scope.close()).rejects.toThrow('drain fixture native observation');
      expect(host.fixture.settled).toBe(true);
      expect(host.observations).toEqual([[4242, 25]]);
    } finally {
      held.resolve(false);
      await held.promise;
    }
  });

  test('preserves the primary failure and a distinct native cleanup failure', async () => {
    const host = new ControlledScopeHost();
    const cleanup = new Error('named native census failure');
    const primary = new Error('named metadata failure');
    host.states.push(cleanup);
    host.allocation.resolve(host.fixture);
    const scope = new DrainFixtureScope(new AbortController().signal, host, 100);
    await scope.allocate();
    scope.markLaneStarted();
    const failure = await withOwnedDrainFixture(scope, {
      start: () => Promise.resolve('started'),
      readPid: () => {
        throw primary;
      },
      check: () => undefined,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
    expect((failure as AggregateError).cause).toBe(primary);
    expect(host.observations).toEqual([[4242, 100]]);
  });

  test('accepts only a timely native absence after the channel closes', async () => {
    const host = new ControlledScopeHost();
    host.states.push(true, false);
    host.allocation.resolve(host.fixture);
    const scope = new DrainFixtureScope(new AbortController().signal, host, 100);
    await scope.allocate();
    scope.markLaneStarted();
    await scope.close();
    expect(host.fixture.settled).toBe(true);
    expect(host.observations).toEqual([
      [4242, 100],
      [4242, 75],
    ]);
  });

  test('rejects native absence that arrives after the observation deadline', async () => {
    const host = new ControlledScopeHost();
    host.readNativeAlive = (pid, timeoutMs) => {
      host.observations.push([pid, timeoutMs]);
      host.time = 101;
      return Promise.resolve(false);
    };
    host.allocation.resolve(host.fixture);
    const scope = new DrainFixtureScope(new AbortController().signal, host, 100);
    await scope.allocate();
    scope.markLaneStarted();
    await expect(scope.close()).rejects.toThrow('received late observation');
    expect(host.observations).toEqual([[4242, 100]]);
  });

  test('rejects a started lane without an authenticated PID', async () => {
    const host = new ControlledScopeHost();
    host.fixture.nativePid = undefined;
    host.allocation.resolve(host.fixture);
    const scope = new DrainFixtureScope(new AbortController().signal, host, 100);
    await scope.allocate();
    scope.markLaneStarted();
    await expect(scope.close()).rejects.toThrow('expected authenticated native PID');
    expect(host.observations).toEqual([]);
  });

  test('closes a late channel even after its allocation cleanup timed out', async () => {
    const host = new ControlledScopeHost();
    const scope = new DrainFixtureScope(new AbortController().signal, host, 25);
    const allocation = scope.allocate().catch((error: unknown) => error);
    await expect(scope.close()).rejects.toThrow('drain fixture allocation cleanup');
    host.allocation.resolve(host.fixture);
    await host.fixture.closeObserved.promise;
    expect(await allocation).toBeInstanceOf(Error);
    expect(host.fixture.closeCalls).toBe(1);
  });

  test('timeout teardown settles channel, lane and callback before fixture removal', async () => {
    const commands = new FixtureCommands();
    try {
      const result = await commands.run(
        [
          process.execPath,
          'test',
          join(import.meta.dir, 'support/worker-drain-lifecycle.fixture.ts'),
          '--timeout',
          '1000',
        ],
        import.meta.dir
      );
      expect(result.exitCode).toBe(1);
      const events = result.stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as WorkerDrainLifecycleEvent);
      expect(events.map((event) => event.event)).toEqual([
        'afterEach',
        'removed',
        'onTestFinished',
      ]);
      expect(events[0]).toMatchObject({ directory: true });
      expect(events[1]).toMatchObject({
        channelOpen: false,
        laneLive: false,
        callbackPending: false,
      });
      expect(events[2]).toMatchObject({ directory: false });
      expect(result.stderr).toContain('timed out after 80ms');
    } finally {
      await commands.settle();
    }
  });
});

describe('retained cooperative drain connection', () => {
  test('rejects missing channel authority before spawning a child', async () => {
    const children = new OwnedDrainChildren();
    await expect(startDrainPipeHolder({ env: {}, onStarted: children.track })).rejects.toThrow(
      `${DRAIN_CHANNEL_ENV}: expected port and private token | received undefined`
    );
    expect(children.children).toEqual([]);
  });

  test('confirms native exit separately after closing the real channel', async () => {
    const scope = new DrainFixtureScope(new AbortController().signal);
    const owner = await scope.allocate();
    const children = new OwnedDrainChildren();
    scope.markLaneStarted();
    try {
      const child = await startDrainPipeHolder({
        env: { ...process.env, ...owner.env },
        onStarted: children.track,
      });
      expect(await owner.ready()).toBe(child.pid);
      expect(owner.nativePid).toBe(child.pid);
      await scope.close();
      expect(owner.settled).toBe(true);
      expect(await children.wait()).toEqual([0]);
    } finally {
      await children.stop();
      await scope.close();
    }
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
