/**
 * `bun test`'s stand-in for Vitest's `vi.advanceTimersByTimeAsync`.
 *
 * Bun 1.4.0's fake timers cover `useFakeTimers`, `useRealTimers`,
 * `advanceTimersByTime`, `advanceTimersToNextTimer`, `runAllTimers` and
 * `setSystemTime` — but there is no async variant of any of them, and every
 * timer-driven assertion in this suite is really waiting on the promise chain a
 * timer callback starts, not on the callback itself.
 *
 * `act` is what closes that gap: it advances the clock, then flushes React's
 * work queue and the microtasks behind it before returning. Callers that are
 * already inside an `act` get a nested one, which React supports.
 *
 * Fake timers also move `Date.now()` (verified on 1.4.0), so code that measures
 * a window by timestamp rather than by timer — `local-write-window.ts` — sees
 * the same jump.
 */

import { jest } from 'bun:test';
import { act } from '@testing-library/react';

let fakeTimersInstalled = false;

/**
 * Use this rather than `jest.useFakeTimers()` directly: `restoreRealTimers()`
 * has to know whether there is a queue to drain, and `advanceTimersByTime`
 * throws outright when fake timers are not active.
 */
export function useFakeTimers(): void {
  jest.useFakeTimers();
  fakeTimersInstalled = true;
}

export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    // The callback has to be genuinely async: `act` only drains the microtask
    // queue between renders when what it awaits is a thenable.
    await Promise.resolve();
  });
}

/**
 * Goes back to real timers without stranding a queued callback.
 *
 * Whatever is still in the fake queue is discarded when real timers come back,
 * and React Query announces every cache change through
 * `notifyManager`'s scheduler — a live `setTimeout(callback, 0)`
 * (`query-core/timeoutManager.js:73`). Drop one of those and the manager never
 * delivers the batch behind it, so a later test in the same file waits forever
 * on a refetch that was requested and simply never announced. Measured: without
 * this flush, one fake-timer test made the next non-fake-timer test in
 * `use-settings-realtime` time out at 5s, while both passed in isolation.
 *
 * Vitest does not need it because `advanceTimersByTimeAsync` flushes between
 * timer callbacks; Bun 1.4.0 has no async advance at all.
 *
 * Safe from an unconditional `afterEach`, which is why it tracks installation
 * itself — `jest.advanceTimersByTime()` throws `Fake timers are not active`
 * when they never were. The suite-wide `bun.setup.ts` `afterEach` calls it for
 * every test, so a file only calls it explicitly when a test needs real timers
 * back mid-body (e.g. before a `waitFor`).
 */
export async function restoreRealTimers(): Promise<void> {
  if (fakeTimersInstalled) {
    await advanceTimersByTimeAsync(0);
    fakeTimersInstalled = false;
  }
  jest.useRealTimers();
}
