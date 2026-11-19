import { jest } from 'bun:test';

/** `bun:test`'s fake timers have an async advance that its type declarations omit. */
interface AsyncAdvancingJest {
  advanceTimersByTimeAsync(ms: number): Promise<void>;
}

/**
 * Moves the fake clock forward and lets every promise continuation the due timers
 * released run before it returns, so a test can step a call that awaits timers.
 * Needs `jest.useFakeTimers()`.
 *
 * @example
 * jest.useFakeTimers();
 * await advanceFakeClock(1_000);
 */
export function advanceFakeClock(ms: number): Promise<void> {
  return (jest as unknown as AsyncAdvancingJest).advanceTimersByTimeAsync(ms);
}
