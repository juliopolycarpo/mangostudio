/**
 * Named fake for the held-tail timer and the clock the throttle reads. `advance`
 * moves time forward and runs every timer that comes due on the way, in order, with
 * `now` set to the instant it was due, so a test decides exactly when a stall ends.
 */
export class ManualHeldTailClock {
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  private nextId = 0;
  scheduled = 0;

  constructor(public now: number) {}

  /** The number of timers waiting to fire. */
  get pending(): number {
    return this.timers.size;
  }

  readonly readNow = (): number => this.now;

  readonly schedule = (run: () => void, delayMs: number): (() => void) => {
    const id = ++this.nextId;
    this.scheduled += 1;
    this.timers.set(id, { at: this.now + delayMs, run });
    return () => {
      this.timers.delete(id);
    };
  };

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = Math.max(this.now, next[1].at);
      this.timers.delete(next[0]);
      next[1].run();
    }
    this.now = end;
  }
}
