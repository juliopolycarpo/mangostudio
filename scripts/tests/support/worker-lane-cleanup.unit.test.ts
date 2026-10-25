import { describe, expect, it } from 'bun:test';
import { withWorkerLaneCleanup } from './worker-lane-cleanup';

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
});
