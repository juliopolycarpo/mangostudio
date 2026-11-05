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
  private nextDelay = 0;

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
    this.sleep = options.sleep ?? Bun.sleep;
  }

  /**
   * Re-read only an unconfirmed result, spending this window's remaining delays.
   * @example await visibility.read(readDraft, (release) => release.state !== 'absent');
   */
  async read<T>(read: () => Promise<T>, visible: (value: T) => boolean): Promise<T> {
    let result = await read();
    while (!visible(result)) {
      const delay = this.delays[this.nextDelay++];
      if (delay === undefined) return result;
      await this.sleep(delay);
      result = await read();
    }
    return result;
  }
}
