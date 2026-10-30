import { onTestFinished, spyOn } from 'bun:test';

interface ControlledDeadline {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly callback: () => void;
  active: boolean;
}

interface NativeBound {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly reject: (error: Error) => void;
}

/**
 * Order the Local fixture's equal manager and chain deadlines independently.
 * Other timer durations retain their real behavior.
 * @example
 * const deadlines = new LocalConnectDeadlines(25); deadlines.fire(0);
 */
class LocalConnectDeadlines {
  readonly delays: number[] = [];
  private readonly timers: ControlledDeadline[] = [];
  private readonly realSchedule = globalThis.setTimeout;
  private readonly realCancel = globalThis.clearTimeout;
  private readonly armed = Promise.withResolvers<void>();
  private readonly bounds = new Set<NativeBound>();
  private disposed = false;
  readonly managerAndChainArmed = this.armed.promise;

  constructor(private readonly deadlineMs: number) {
    void this.armed.promise.catch(() => undefined);
  }

  readonly schedule = (
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    if (this.disposed || delay !== this.deadlineMs)
      return this.realSchedule(callback, delay, ...args);
    // A cancelled native handle retains clearTimeout's real identity without
    // introducing a background timer while this fixture controls its callback.
    const timer = this.realSchedule(() => undefined, 0);
    this.realCancel(timer);
    this.timers.push({ timer, callback: () => callback(...args), active: true });
    this.delays.push(delay);
    if (this.timers.length === 2) this.armed.resolve();
    return timer;
  };

  readonly cancel = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    const controlled = this.timers.find((entry) => entry.timer === timer);
    if (controlled) controlled.active = false;
    this.realCancel(timer);
  };

  fire(index: number): void {
    const deadline = this.timers[index];
    if (!deadline?.active) {
      throw new Error(`expected active Local deadline #${index} | received: missing or cleared`);
    }
    deadline.active = false;
    deadline.callback();
  }

  /**
   * Bound a fixture phase with the native timer captured before interception.
   * @example await deadlines.within(openReady, 'second Local open', 2_000);
   */
  async within<T>(pending: Promise<T>, phase: string, timeoutMs: number): Promise<T> {
    if (this.disposed) {
      void pending.catch(() => undefined);
      throw new Error(`expected active Local fixture for ${phase} | received: disposed`);
    }
    const expired = Promise.withResolvers<never>();
    const timer = this.realSchedule(
      () =>
        expired.reject(
          new Error(`expected ${phase} to settle within ${timeoutMs}ms | received: pending`)
        ),
      timeoutMs
    );
    const bound: NativeBound = { timer, reject: expired.reject };
    this.bounds.add(bound);
    try {
      return await Promise.race([pending, expired.promise]);
    } finally {
      this.realCancel(timer);
      this.bounds.delete(bound);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failure = new Error('Local deadline fixture disposed');
    this.armed.reject(failure);
    for (const bound of this.bounds) {
      this.realCancel(bound.timer);
      bound.reject(failure);
    }
    this.bounds.clear();
    for (const deadline of this.timers) {
      deadline.active = false;
      this.realCancel(deadline.timer);
    }
  }
}

/**
 * Install the Local deadline fixture for one test.
 * @example const { deadlines, restore } = useLocalConnectDeadlines(25);
 */
export function useLocalConnectDeadlines(deadlineMs: number) {
  const deadlines = new LocalConnectDeadlines(deadlineMs);
  let restored = false;
  let restoreSchedule: () => void = () => undefined;
  let restoreCancel: () => void = () => undefined;
  const restore = () => {
    if (restored) return;
    restored = true;
    deadlines.dispose();
    restoreCancel();
    restoreSchedule();
  };
  // Register before the first spy: test completion must restore global state
  // even when a later assertion, readiness wait or cleanup never settles.
  onTestFinished(restore);
  const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(
    deadlines.schedule as typeof setTimeout
  );
  restoreSchedule = () => {
    schedule.mockRestore();
  };
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation(
    deadlines.cancel as typeof clearTimeout
  );
  restoreCancel = () => {
    cancel.mockRestore();
  };
  return { deadlines, restore };
}
