const VISIBILITY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000] as const;
const MAX_VISIBILITY_WAIT_MS = 60_000;

/** Controlled post-write polling; callers can shorten the shared wait budget. */
export interface CanaryVisibilityOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Share at most 60 seconds of retry delays across post-write visibility reads.
 * A successful response is returned once; errors propagate without a retry.
 * Exhaustion returns the last observation for the caller's strict audit failure.
 * @example const visibility = new CanaryVisibilityWindow();
 */
export class CanaryVisibilityWindow {
  private readonly delays: readonly number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private remainingWaitMs: number;

  constructor(options: CanaryVisibilityOptions = {}) {
    const delays = options.retryDelaysMs ?? VISIBILITY_DELAYS_MS;
    if (
      !Array.isArray(delays) ||
      delays.length > 16 ||
      delays.some((delay) => typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) ||
      delays.reduce((total, delay) => total + delay, 0) > MAX_VISIBILITY_WAIT_MS
    ) {
      throw new Error(
        `Invalid canary visibility delays: expected at most 16 finite nonnegative millisecond delays totaling at most ${MAX_VISIBILITY_WAIT_MS}; received ${Array.isArray(delays) ? `[${delays.map(String).join(', ')}]` : String(delays)}`
      );
    }
    this.delays = [...delays];
    this.remainingWaitMs = this.delays.reduce((total, delay) => total + delay, 0);
    this.sleep = options.sleep ?? Bun.sleep;
  }

  /**
   * Restart backoff for this lookup while sharing the remaining delay budget.
   * @example await visibility.read(readDraft, (release) => release.state !== 'absent');
   */
  async read<T>(read: () => Promise<T>, visible: (value: T) => boolean): Promise<T> {
    let result = await read();
    let nextDelay = 0;
    while (!visible(result)) {
      const configuredDelay = this.delays[nextDelay++];
      if (configuredDelay === undefined || (configuredDelay > 0 && this.remainingWaitMs === 0))
        return result;
      const delay = Math.min(configuredDelay, this.remainingWaitMs);
      this.remainingWaitMs -= delay;
      await this.sleep(delay);
      result = await read();
    }
    return result;
  }
}
