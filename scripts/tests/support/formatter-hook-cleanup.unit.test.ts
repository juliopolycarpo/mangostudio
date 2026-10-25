import { describe, expect, it } from 'bun:test';
import { stopPath } from './fake-rustfmt-markers';
import { withFormatterHookCleanup } from './formatter-hook-cleanup';

/** The formatter's detached descendants outlive the hook until explicitly stopped. */
class FailedCancellation {
  readonly live = new Set([101, 201, 301]);
  readonly signals: Array<[number, NodeJS.Signals]> = [];
  readonly markers = [
    ['formatter', 'fake rustfmt'],
    ['grandchild', 'fake rustfmt grandchild'],
  ] as const;
  private readonly pids = new Map([
    ['formatter', 201],
    ['grandchild', 301],
  ]);
  readonly markerReads: string[] = [];
  readonly heartbeatReads: string[] = [];
  readonly stopRequests: string[] = [];
  readonly publishedStops = new Set<string>();
  readonly writeRefused = new Set<string>();
  readonly refused = new Set<number>();
  reuseAfterPositiveSample = false;
  positiveSamples = 0;
  lateStartOnHookStop = false;
  lateStartPrevented = false;
  readonly unrelated = new Set<number>();
  readonly unrelatedSignals: number[] = [];
  private resolveExit: () => void = () => undefined;
  readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  private reportStopping: () => void = () => undefined;
  readonly stopping = new Promise<void>((resolve) => {
    this.reportStopping = resolve;
  });

  constructor(
    readonly failure: Error,
    private readonly automaticExit = true
  ) {}

  readonly kill = (signal: NodeJS.Signals): void => {
    this.signals.push([101, signal]);
    if (this.lateStartOnHookStop) {
      this.lateStartPrevented = this.publishedStops.has('grandchild');
      if (!this.lateStartPrevented) this.live.add(301);
    }
    this.reportStopping();
    if (this.automaticExit) this.finishHook();
  };

  finishHook(): void {
    this.live.delete(101);
    this.resolveExit();
  }

  readonly readMarker = (marker: string): Promise<{ pid: number }> => {
    this.markerReads.push(marker);
    const pid = this.pids.get(marker);
    if (pid === undefined) throw new Error(`expected an owned marker | received: ${marker}`);
    return Promise.resolve({ pid });
  };

  readonly stillBeating = (marker: string): Promise<boolean> => {
    this.heartbeatReads.push(marker);
    const pid = this.pids.get(marker);
    if (marker === 'formatter' && this.reuseAfterPositiveSample) {
      this.reuseAfterPositiveSample = false;
      this.positiveSamples++;
      this.live.delete(201);
      this.unrelated.add(201);
      return Promise.resolve(true);
    }
    if (pid !== undefined && this.publishedStops.has(marker) && !this.refused.has(pid)) {
      this.live.delete(pid);
    }
    return Promise.resolve(pid !== undefined && this.live.has(pid));
  };

  readonly requestStop = (marker: string): Promise<void> => {
    if (!this.pids.has(marker)) {
      throw new Error(`expected an owned stop marker | received: ${marker}`);
    }
    this.stopRequests.push(marker);
    if (this.writeRefused.has(marker)) {
      throw new Error(`controlled stop publication refusal for ${marker}`);
    }
    this.publishedStops.add(marker);
    return Promise.resolve();
  };

  readonly signal = (pid: number, signal: NodeJS.Signals): true => {
    if (![201, 301].includes(pid) || signal !== 'SIGKILL') {
      throw new Error(`expected an owned formatter SIGKILL | received: ${pid} ${signal}`);
    }
    if (this.refused.has(pid)) throw new Error(`controlled signal refusal for ${pid}`);
    if (this.unrelated.has(pid)) {
      this.unrelatedSignals.push(pid);
      this.unrelated.delete(pid);
    }
    this.signals.push([pid, signal]);
    this.live.delete(pid);
    return true;
  };

  readonly heartbeatFailure = (): Promise<never> => Promise.reject(this.failure);
  readonly signalFailure = (): Promise<never> => {
    throw this.failure;
  };
}

describe('formatter hook failure cleanup', () => {
  it('addresses stop requests by the unique formatter marker', () => {
    expect(stopPath('/tmp/started.json')).toBe('/tmp/started.json.stop');
  });

  it.each(['heartbeat', 'signal'] as const)(
    'settles every owned process after an early %s failure',
    async (phase) => {
      const failure = new Error(`controlled ${phase} failure before leak discovery`);
      const scope = new FailedCancellation(failure);
      const run = phase === 'heartbeat' ? scope.heartbeatFailure : scope.signalFailure;
      await expect(withFormatterHookCleanup(scope, scope.markers, run, scope)).rejects.toBe(
        failure
      );
      expect(
        [...scope.live],
        `${phase}: expected an empty owned process scope before fixture removal`
      ).toEqual([]);
      expect(scope.signals).toEqual([[101, 'SIGTERM']]);
      expect(scope.stopRequests).toEqual(['formatter', 'grandchild']);
      expect(scope.markerReads).toEqual([]);
    }
  );

  it('awaits hook settlement before sampling its descendants', async () => {
    const failure = new Error('controlled heartbeat failure');
    const scope = new FailedCancellation(failure, false);
    const running = withFormatterHookCleanup(
      scope,
      scope.markers,
      scope.heartbeatFailure,
      scope
    ).catch((error) => error);
    await scope.stopping;
    expect(scope.stopRequests).toEqual(['formatter', 'grandchild']);
    expect(scope.heartbeatReads).toEqual([]);
    expect([...scope.live]).toEqual([101, 201, 301]);
    scope.finishHook();
    expect(await running).toBe(failure);
    expect([...scope.live]).toEqual([]);
  });

  it('publishes stop requests only after the protected assertions finish', async () => {
    const scope = new FailedCancellation(new Error('unused failure'));
    await withFormatterHookCleanup(
      scope,
      scope.markers,
      () => {
        expect(scope.stopRequests).toEqual([]);
        expect(scope.signals).toEqual([]);
        expect([...scope.live]).toEqual([101, 201, 301]);
        return Promise.resolve();
      },
      scope
    );
    expect(scope.stopRequests).toEqual(['formatter', 'grandchild']);
    expect([...scope.live]).toEqual([]);
  });

  it('never signals a stopped formatter identity even if its old pid was reused', async () => {
    const scope = new FailedCancellation(new Error('unused failure'));
    scope.live.delete(201);
    expect(
      await withFormatterHookCleanup(scope, scope.markers, () => Promise.resolve('ok'), scope)
    ).toBe('ok');
    expect(scope.signals).toEqual([[101, 'SIGTERM']]);
    expect([...scope.live]).toEqual([]);
  });

  it('never signals a pid reused after a positive heartbeat sample', async () => {
    const scope = new FailedCancellation(new Error('unused failure'));
    scope.reuseAfterPositiveSample = true;
    await withFormatterHookCleanup(scope, scope.markers, () => Promise.resolve('ok'), scope);
    expect(
      scope.unrelatedSignals,
      'expected no signal to an unrelated process that reused the sampled formatter pid'
    ).toEqual([]);
    expect(scope.positiveSamples).toBe(1);
    expect([...scope.unrelated]).toEqual([201]);
    expect(scope.stopRequests).toEqual(['formatter', 'grandchild']);
    expect(scope.signals).toEqual([[101, 'SIGTERM']]);
  });

  it('requests both stop paths before a late child can create its marker', async () => {
    const scope = new FailedCancellation(new Error('controlled heartbeat failure'));
    scope.live.delete(301);
    scope.lateStartOnHookStop = true;
    await expect(
      withFormatterHookCleanup(scope, scope.markers, scope.heartbeatFailure, scope)
    ).rejects.toBe(scope.failure);
    expect(scope.lateStartPrevented).toBe(true);
    expect(scope.stopRequests).toEqual(['formatter', 'grandchild']);
    expect(scope.markerReads).toEqual([]);
    expect([...scope.live]).toEqual([]);
  });

  it('retains the original failure and reports a descendant that cleanup could not stop', async () => {
    const failure = new Error('controlled early signal failure');
    const scope = new FailedCancellation(failure);
    scope.refused.add(201);
    const error = await withFormatterHookCleanup(
      scope,
      scope.markers,
      scope.signalFailure,
      scope
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(failure);
    expect(error.errors[0]).toBe(failure);
    expect(error.errors[1].errors[0].message).toContain(
      'fake rustfmt (formatter): expected a stopped heartbeat within 4 cleanup observations | received: still beating'
    );
    expect([...scope.live]).toEqual([201]);
    expect(scope.heartbeatReads.filter((marker) => marker === 'formatter')).toHaveLength(4);
    expect(scope.markerReads).toEqual([]);
  });

  it('fails a successful assertion when an owned formatter survives cleanup', async () => {
    const scope = new FailedCancellation(new Error('unused failure'));
    scope.refused.add(201);
    await expect(
      withFormatterHookCleanup(scope, scope.markers, () => Promise.resolve('ok'), scope)
    ).rejects.toThrow('formatter fixture cleanup failed');
    expect([...scope.live]).toEqual([201]);
    expect(scope.heartbeatReads.filter((marker) => marker === 'formatter')).toHaveLength(4);
    expect(scope.markerReads).toEqual([]);
  });

  it('still stops the hook and requests its sibling when one stop publication fails', async () => {
    const scope = new FailedCancellation(new Error('controlled heartbeat failure'));
    scope.writeRefused.add('formatter');
    const error = await withFormatterHookCleanup(
      scope,
      scope.markers,
      scope.heartbeatFailure,
      scope
    ).catch((caught) => caught);
    expect(error.cause).toBe(scope.failure);
    expect(error.errors[1].errors[0].message).toBe(
      'controlled stop publication refusal for formatter'
    );
    expect(scope.stopRequests).toEqual(['formatter', 'grandchild']);
    expect(scope.signals).toEqual([[101, 'SIGTERM']]);
    expect([...scope.live]).toEqual([201]);
  });
});
