/**
 * Starts `run` after `delayMs` and returns a function that cancels it. The default
 * timer is unref'd so a held tail never keeps the process alive.
 */
export type HeldTailScheduler = (run: () => void, delayMs: number) => () => void;

export const scheduleUnrefTimer: HeldTailScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Milliseconds until the throttle's time window, measured from the last accepted
 * write, runs out. Never negative.
 */
export function heldTailDelay(lastAcceptedAt: number, now: number, windowMs: number): number {
  return Math.max(0, lastAcceptedAt + windowMs - now);
}

/**
 * One trailing timer for a checkpoint writer's throttle.
 *
 * The throttle is only evaluated when a delta arrives, so a best-effort call it
 * skips leaves state unwritten until the next delta, however long the provider
 * stays silent. A writer arms this when it skips a call, for the rest of the time
 * window, and the timer writes the held tail if no accepted write got there first.
 * The writer cancels it on every accepted write and closes it when the turn ends.
 */
export class HeldTailTimer {
  private cancelPending: (() => void) | null = null;
  private closed = false;

  constructor(private readonly schedule: HeldTailScheduler = scheduleUnrefTimer) {}

  /** Whether a timer is waiting to fire. */
  get armed(): boolean {
    return this.cancelPending !== null;
  }

  /** Arms one timer; a second call while one is waiting keeps the first, which is due sooner. */
  arm(delayMs: number, run: () => void): void {
    if (this.closed || this.cancelPending) return;
    this.cancelPending = this.schedule(() => {
      this.cancelPending = null;
      if (!this.closed) run();
    }, delayMs);
  }

  cancel(): void {
    this.cancelPending?.();
    this.cancelPending = null;
  }

  /** Cancels the timer and refuses to arm another: nothing is written after the turn's end. */
  close(): void {
    this.closed = true;
    this.cancel();
  }
}
