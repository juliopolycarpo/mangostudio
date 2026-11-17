import { afterEach, describe, expect, it } from 'bun:test';

import { HIGHLIGHT_RETRY_IDLE_TIMEOUT_MS, retryStoppedHighlights } from '@/lib/highlight-retry';

import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';

let idle: FakeIdleScheduler | undefined;

afterEach(() => {
  idle?.restore();
  idle = undefined;
});

/** A retry that records when it ran and answers whether it coloured its block. */
class RecordedRetry {
  runs = 0;

  constructor(private readonly recovers: boolean) {}

  run = (): boolean => {
    this.runs++;
    return this.recovers;
  };
}

class RecoveryCounter {
  calls = 0;
  notify = (): void => {
    this.calls++;
  };
}

function installIdle(): FakeIdleScheduler {
  idle = new FakeIdleScheduler().install();
  return idle;
}

describe('retryStoppedHighlights', () => {
  it('runs nothing before an idle moment, then each retry in its own callback', async () => {
    const scheduler = installIdle();
    const first = new RecordedRetry(true);
    const second = new RecordedRetry(false);
    const recovered = new RecoveryCounter();
    retryStoppedHighlights([first.run, second.run], recovered.notify);

    expect(first.runs, 'first retry before idle').toBe(0);
    expect(scheduler.timeouts, 'idle timeouts requested').toEqual([
      HIGHLIGHT_RETRY_IDLE_TIMEOUT_MS,
    ]);

    await scheduler.runIdle();
    expect([first.runs, second.runs], 'runs after one idle callback').toEqual([1, 0]);
    await scheduler.runIdle();
    expect([first.runs, second.runs], 'runs after two idle callbacks').toEqual([1, 1]);
    expect(recovered.calls, 'recovery notifications for one coloured block').toBe(1);
  });

  it('does not report a recovery when no block was coloured', async () => {
    const scheduler = installIdle();
    const recovered = new RecoveryCounter();
    retryStoppedHighlights([new RecordedRetry(false).run], recovered.notify);
    await scheduler.runIdle();
    expect(recovered.calls, 'recovery notifications when every retry stopped again').toBe(0);
    expect(scheduler.pending, 'idle callbacks left').toBe(0);
  });

  it('cancels the callback that has not run, and the ones after it', async () => {
    const scheduler = installIdle();
    const first = new RecordedRetry(true);
    const second = new RecordedRetry(true);
    const recovered = new RecoveryCounter();
    const cancel = retryStoppedHighlights([first.run, second.run], recovered.notify);
    await scheduler.runIdle();
    cancel();
    await scheduler.runIdle();

    expect([first.runs, second.runs], 'runs after cancel').toEqual([1, 0]);
    expect(recovered.calls, 'recovery notifications after cancel').toBe(0);
  });

  it('schedules nothing for an empty list', () => {
    const scheduler = installIdle();
    retryStoppedHighlights([], new RecoveryCounter().notify)();
    expect(scheduler.pending).toBe(0);
  });
});
