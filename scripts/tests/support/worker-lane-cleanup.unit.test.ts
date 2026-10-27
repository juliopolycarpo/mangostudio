import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { FixtureCommands } from './fixture-command';
import {
  settleWorkerLanesBeforeRemoval,
  trackWorkerHandle,
  trackWorkerStream,
  withWorkerLaneCleanup,
  WorkerLaneOwner,
} from './worker-lane-cleanup';
import type { WorkerLaneLifecycleEvent } from './worker-lane-lifecycle.fixture';

/** An already-started lane whose workers stop only after abort reaches the owner. */
class OwnedWorkerLane {
  readonly controller = new AbortController();
  readonly liveWorkers = new Set([1, 2, 3]);
  readonly events = ['workers started'];
  private resolveLane: () => void = () => undefined;
  private rejectLane: (error: Error) => void = () => undefined;
  readonly running = new Promise<void>((resolve, reject) => {
    this.resolveLane = resolve;
    this.rejectLane = reject;
  });
  private reportAbort: () => void = () => undefined;
  readonly abortReached = new Promise<void>((resolve) => {
    this.reportAbort = resolve;
  });

  constructor(
    readonly failure: Error,
    private readonly automaticSettlement = true,
    private readonly cleanupFailure?: Error
  ) {
    this.controller.signal.addEventListener('abort', this.cancel, { once: true });
  }

  private readonly cancel = (): void => {
    this.events.push('abort');
    this.reportAbort();
    if (this.automaticSettlement) queueMicrotask(() => this.settle());
  };

  settle(): void {
    this.liveWorkers.clear();
    this.events.push('lane settled');
    if (this.cleanupFailure) this.rejectLane(this.cleanupFailure);
    else this.resolveLane();
  }

  readonly readinessFailure = (): Promise<never> => {
    this.events.push('readiness failed');
    return Promise.reject(this.failure);
  };

  readonly markerReadFailure = (): Promise<never> => {
    this.events.push('pid read failed');
    throw this.failure;
  };
}

describe('worker cancellation fixture cleanup', () => {
  it.each(['readiness', 'pid read'] as const)(
    'settles all started workers after an early %s failure',
    async (phase) => {
      const failure = new Error(`controlled ${phase} failure before cancellation`);
      const lane = new OwnedWorkerLane(failure);
      const run = phase === 'readiness' ? lane.readinessFailure : lane.markerReadFailure;
      await expect(withWorkerLaneCleanup(lane.controller, lane.running, run)).rejects.toBe(failure);
      expect(
        [...lane.liveWorkers],
        `${phase}: expected live workers: 0 before fixture removal | received: ${lane.liveWorkers.size}`
      ).toEqual([]);
      expect(lane.events).toEqual(['workers started', `${phase} failed`, 'abort', 'lane settled']);
    }
  );

  it('awaits lane settlement before fixture cleanup can run', async () => {
    const failure = new Error('controlled readiness failure');
    const lane = new OwnedWorkerLane(failure, false);
    let fixtureRemoved = false;
    const finished = withWorkerLaneCleanup(
      lane.controller,
      lane.running,
      lane.readinessFailure
    ).catch((error) => {
      fixtureRemoved = true;
      return error;
    });
    await lane.abortReached;
    expect(fixtureRemoved).toBe(false);
    expect([...lane.liveWorkers]).toEqual([1, 2, 3]);
    lane.settle();
    expect(await finished).toBe(failure);
    expect(fixtureRemoved).toBe(true);
    expect([...lane.liveWorkers]).toEqual([]);
  });

  it('preserves the setup failure when lane settlement also rejects', async () => {
    const failure = new Error('controlled pid-file read failure');
    const cleanupFailure = new Error('controlled lane report failure after worker exit');
    const lane = new OwnedWorkerLane(failure, true, cleanupFailure);
    const error = await withWorkerLaneCleanup(
      lane.controller,
      lane.running,
      lane.markerReadFailure
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(failure);
    expect(error.errors).toEqual([failure, cleanupFailure]);
    expect([...lane.liveWorkers]).toEqual([]);
  });

  it('fails successful assertions when lane cleanup rejects', async () => {
    const cleanupFailure = new Error('controlled lane report failure after worker exit');
    const lane = new OwnedWorkerLane(new Error('unused setup failure'), true, cleanupFailure);
    await expect(
      withWorkerLaneCleanup(lane.controller, lane.running, () => Promise.resolve('ok'))
    ).rejects.toBe(cleanupFailure);
    expect([...lane.liveWorkers]).toEqual([]);
  });

  it('returns the assertion result only after cancelling and settling the lane', async () => {
    const lane = new OwnedWorkerLane(new Error('unused setup failure'));
    expect(
      await withWorkerLaneCleanup(lane.controller, lane.running, () => Promise.resolve('ok'))
    ).toBe('ok');
    expect(lane.controller.signal.aborted).toBe(true);
    expect(lane.events).toEqual(['workers started', 'abort', 'lane settled']);
    expect([...lane.liveWorkers]).toEqual([]);
  });

  it('does not duplicate a lane failure already raised by the assertions', async () => {
    const failure = new Error('controlled lane report failure after worker exit');
    const lane = new OwnedWorkerLane(new Error('unused setup failure'), true, failure);
    await expect(
      withWorkerLaneCleanup(lane.controller, lane.running, async () => {
        lane.controller.abort();
        await lane.running;
      })
    ).rejects.toBe(failure);
    expect(lane.events).toEqual(['workers started', 'abort', 'lane settled']);
    expect([...lane.liveWorkers]).toEqual([]);
  });
  it('removes settled fixture storage after the assertion fails', async () => {
    const failure = new Error('named assertion failure');
    const lane = new OwnedWorkerLane(failure);
    const owner = new WorkerLaneOwner(lane.controller);
    void owner.start(() => lane.running);
    const result = await owner.run(lane.readinessFailure).catch((error: unknown) => error);
    let removed = false;
    await settleWorkerLanesBeforeRemoval([owner], () => {
      removed = true;
    });
    expect(result).toBe(failure);
    expect(removed).toBe(true);
    expect([...lane.liveWorkers]).toEqual([]);
  });

  it('waits for tracked worker exit and reader completion before removal', async () => {
    const lane = new OwnedWorkerLane(new Error('unused'));
    const owner = new WorkerLaneOwner(lane.controller, { timeoutMs: 500 });
    void owner.start(() => lane.running);
    let releaseExit!: () => void;
    let releaseReader!: () => void;
    const exit = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const reader = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    owner.track(exit);
    owner.track(reader);
    const callback = owner.run(() => Promise.resolve());
    await Promise.resolve();
    let removed = false;
    const teardown = settleWorkerLanesBeforeRemoval([owner], () => {
      removed = true;
    });
    try {
      await lane.abortReached;
      expect(removed).toBe(false);
      releaseExit();
      await Promise.resolve();
      expect(removed).toBe(false);
      releaseReader();
      await teardown;
      await callback;
      expect(removed).toBe(true);
    } finally {
      releaseExit();
      releaseReader();
      await callback;
    }
  });

  it('does not treat an abort-reason native-exit rejection as settlement', async () => {
    const lane = new OwnedWorkerLane(new Error('unused'));
    const owner = new WorkerLaneOwner(lane.controller);
    void owner.start(() => lane.running);
    const exit = new Promise<never>((_resolve, reject) => {
      lane.controller.signal.addEventListener(
        'abort',
        () => reject(lane.controller.signal.reason),
        { once: true }
      );
    });
    owner.track(exit);
    let removed = false;
    const failure = await settleWorkerLanesBeforeRemoval([owner], () => {
      removed = true;
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(lane.controller.signal.reason);
    expect(removed).toBe(false);
  });

  it('tracks a reader cancellation registered after cleanup starts', async () => {
    const lane = new OwnedWorkerLane(new Error('unused'));
    const owner = new WorkerLaneOwner(lane.controller, { timeoutMs: 500 });
    void owner.start(() => lane.running);
    let releaseProducer!: () => void;
    let releaseCancellation!: () => void;
    const producer = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    owner.track(producer);
    const heldCancel = () => cancellationGate;
    const stream = new ReadableStream<Uint8Array>({ cancel: heldCancel });
    const reader = trackWorkerStream(stream, owner).getReader();
    const read = reader.read();
    let removed = false;
    const teardown = settleWorkerLanesBeforeRemoval([owner], () => {
      removed = true;
    });
    try {
      await lane.abortReached;
      const cancel = reader.cancel();
      expect((await read).done).toBe(true);
      releaseProducer();
      const removedBeforeCancellation = await Promise.race([
        teardown.then(() => true),
        Bun.sleep(50).then(() => false),
      ]);
      expect(removedBeforeCancellation).toBe(false);
      expect(removed).toBe(false);
      releaseCancellation();
      await cancel;
      await teardown;
      expect(removed).toBe(true);
    } finally {
      releaseProducer();
      releaseCancellation();
      reader.releaseLock();
    }
  });

  it('retains storage when reader cancellation rejects after the lane aborts', async () => {
    const lane = new OwnedWorkerLane(new Error('unused'));
    const owner = new WorkerLaneOwner(lane.controller, { timeoutMs: 500 });
    void owner.start(() => lane.running);
    let finishProducer!: () => void;
    const producer = new Promise<void>((resolve) => {
      finishProducer = resolve;
    });
    owner.track(producer);
    const failure = new Error('named reader cancellation failure');
    const refusingCancel = () => Promise.reject(failure);
    const stream = new ReadableStream<Uint8Array>({ cancel: refusingCancel });
    const reader = trackWorkerStream(stream, owner).getReader();
    const pendingRead = reader.read();
    let removed = false;
    const teardown = settleWorkerLanesBeforeRemoval([owner], () => {
      removed = true;
    }).catch((error: unknown) => error);
    try {
      await lane.abortReached;
      const cancel = reader.cancel().catch((error: unknown) => error);
      await pendingRead;
      expect(await cancel).toBe(failure);
      finishProducer();
      const received = await teardown;
      expect(received).toBeInstanceOf(AggregateError);
      expect((received as AggregateError).errors).toContain(failure);
      expect(removed).toBe(false);
    } finally {
      finishProducer();
      reader.releaseLock();
    }
  });

  it('forwards worker bytes and read errors through the single original reader', async () => {
    const lane = new OwnedWorkerLane(new Error('unused'));
    const owner = new WorkerLaneOwner(lane.controller);
    void owner.start(() => lane.running);
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
    });
    const reader = trackWorkerStream(stream, owner).getReader();
    const failure = new Error('named read failure');
    try {
      expect(stream.locked).toBe(true);
      source.enqueue(new Uint8Array([1, 2, 3]));
      expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
      source.error(failure);
      await expect(reader.read()).rejects.toBe(failure);
      await owner.close();
    } finally {
      reader.releaseLock();
    }
    expect(stream.locked).toBe(false);
  });

  it('preserves an independent lane failure when a sibling remains held until cleanup deadline', async () => {
    const controller = new AbortController();
    const owner = new WorkerLaneOwner(controller, { timeoutMs: 25 });
    const failure = new Error('named early lane failure');
    void owner.start(() => Promise.reject(failure));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    owner.track(held);
    let removed = false;
    try {
      const received = await settleWorkerLanesBeforeRemoval([owner], () => {
        removed = true;
      }).catch((error: unknown) => error);
      expect(received).toBeInstanceOf(AggregateError);
      const detail = (received as AggregateError).errors[0];
      expect(detail).toBeInstanceOf(AggregateError);
      expect((detail as AggregateError).errors).toContain(failure);
      expect(
        (detail as AggregateError).errors.some((error: unknown) =>
          String(error).includes('did not settle')
        )
      ).toBe(true);
      expect(removed).toBe(false);
    } finally {
      release();
      await held;
    }
  });

  it('retains storage on late native settlement failure or unconfirmed leftovers', async () => {
    for (const mode of ['failure', 'leftover'] as const) {
      const lane = new OwnedWorkerLane(new Error('unused'));
      const owner = new WorkerLaneOwner(lane.controller, { timeoutMs: 500 });
      void owner.start(() => lane.running);
      let releaseProducer!: () => void;
      const producer = new Promise<void>((resolve) => {
        releaseProducer = resolve;
      });
      owner.track(producer);
      const failure = new Error('named native census failure');
      const leftovers = [{ pid: 4242, command: 'named held descendant' }];
      const fakeHandle = {
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
        settle: () => (mode === 'failure' ? Promise.reject(failure) : Promise.resolve(leftovers)),
      };
      const handle = trackWorkerHandle(fakeHandle, owner);
      let removed = false;
      const teardown = settleWorkerLanesBeforeRemoval([owner], () => {
        removed = true;
      }).catch((error: unknown) => error);
      try {
        await lane.abortReached;
        const settlement = handle.settle?.().catch((error: unknown) => error);
        expect(await settlement).toEqual(mode === 'failure' ? failure : leftovers);
        releaseProducer();
        const received = await teardown;
        expect(received).toBeInstanceOf(AggregateError);
        expect(removed).toBe(false);
        if (mode === 'failure') expect((received as AggregateError).errors).toContain(failure);
        else
          expect(String((received as AggregateError).errors[0])).toContain('unconfirmed leftovers');
      } finally {
        releaseProducer();
      }
    }
  });

  it('holds fixture removal until the readiness callback and lane both settle', async () => {
    const lane = new OwnedWorkerLane(new Error('unused'), false);
    const owner = new WorkerLaneOwner(lane.controller, { timeoutMs: 500 });
    void owner.start(() => lane.running);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = owner
      .run(async () => {
        await held;
        lane.controller.signal.throwIfAborted();
      })
      .catch((error: unknown) => error);
    await Promise.resolve();
    let removed = false;
    const teardown = settleWorkerLanesBeforeRemoval([owner], () => {
      removed = true;
    });
    try {
      await lane.abortReached;
      expect(removed).toBe(false);
      lane.settle();
      await Promise.resolve();
      expect(removed).toBe(false);
      release();
      await teardown;
      expect(removed).toBe(true);
      expect(await callback).toBe(lane.controller.signal.reason);
      expect([...lane.liveWorkers]).toEqual([]);
    } finally {
      release();
      lane.settle();
      await callback;
    }
  });

  it('retains storage when a held callback or worker cannot settle before cleanup deadline', async () => {
    const lane = new OwnedWorkerLane(new Error('unused'), false);
    const owner = new WorkerLaneOwner(lane.controller, { timeoutMs: 25 });
    void owner.start(() => lane.running);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = owner.run(() => held).catch((error: unknown) => error);
    await Promise.resolve();
    let removed = false;
    try {
      await expect(
        settleWorkerLanesBeforeRemoval([owner], () => {
          removed = true;
        })
      ).rejects.toThrow('storage retained');
      expect(removed).toBe(false);
      expect([...lane.liveWorkers]).toEqual([1, 2, 3]);
    } finally {
      release();
      lane.settle();
      await callback;
    }
  });

  it('proves Bun runs afterEach before test-finish cleanup on a timed-out held callback', async () => {
    const commands = new FixtureCommands();
    try {
      const result = await commands.run(
        [
          process.execPath,
          'test',
          join(import.meta.dir, 'worker-lane-lifecycle.fixture.ts'),
          '--timeout',
          '1000',
        ],
        import.meta.dir
      );
      expect(result.exitCode).toBe(1);
      const events = result.stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as WorkerLaneLifecycleEvent);
      expect(events.map((event) => event.event)).toEqual([
        'afterEach',
        'abort',
        'lane-settled',
        'removed',
        'onTestFinished',
      ]);
      expect(events[0]).toMatchObject({ live: true, directory: true });
      expect(events[2]).toMatchObject({ directory: true });
      expect(events[3]).toMatchObject({ live: false });
      expect(events[4]).toMatchObject({ live: false, directory: false });
      expect(result.stderr).toContain('timed out after 80ms');
    } finally {
      await commands.settle();
    }
  });
});
