const VISIBILITY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000] as const;
const MAX_VISIBILITY_WAIT_MS = 60_000;
const MAX_VISIBILITY_TTL_MS = 1_200_000;
const MAX_VISIBILITY_DELAYS = 16;
const MAX_TTL_VISIBILITY_DELAYS = 32;

/** Controlled post-write polling; callers can shorten the shared wait budget. */
export interface CanaryVisibilityOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Optional shared elapsed-time limit, including I/O; at most twenty minutes. */
  readonly ttlMs?: number;
  /** Monotonic clock; fake sleeps must advance this clock. */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/**
 * Share a bounded delay budget across post-write reads. An optional TTL also
 * bounds I/O and aborts outstanding reads. Errors propagate without a retry.
 * Exhaustion returns the last observation for the caller's strict audit failure.
 * @example const visibility = new CanaryVisibilityWindow();
 */
export class CanaryVisibilityWindow {
  private readonly delays: readonly number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly ttlMs: number | undefined;
  private readonly log: ((message: string) => void) | undefined;
  private startedAt: number | undefined;
  private lastObservation = 'no response';
  private expiration: Error | undefined;
  private remainingWaitMs: number;

  constructor(options: CanaryVisibilityOptions = {}) {
    const ttl = options.ttlMs;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_VISIBILITY_TTL_MS)) {
      throw new Error(
        `Invalid canary visibility TTL: expected finite milliseconds in (0, ${MAX_VISIBILITY_TTL_MS}]; received ${ttl}`
      );
    }
    const maxWait = ttl === undefined ? MAX_VISIBILITY_WAIT_MS : MAX_VISIBILITY_TTL_MS;
    const delays = options.retryDelaysMs ?? VISIBILITY_DELAYS_MS;
    const maxDelays = ttl === undefined ? MAX_VISIBILITY_DELAYS : MAX_TTL_VISIBILITY_DELAYS;
    if (
      !Array.isArray(delays) ||
      delays.length > maxDelays ||
      delays.some((delay) => typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) ||
      delays.reduce((total, delay) => total + delay, 0) > maxWait
    ) {
      throw new Error(
        `Invalid canary visibility delays: expected at most ${maxDelays} finite nonnegative millisecond delays totaling at most ${maxWait}; received ${Array.isArray(delays) ? `[${delays.map(String).join(', ')}]` : String(delays)}`
      );
    }
    this.delays = [...delays];
    this.remainingWaitMs = this.delays.reduce((total, delay) => total + delay, 0);
    this.sleep = options.sleep ?? Bun.sleep;
    this.now = options.now ?? (() => performance.now());
    this.ttlMs = ttl;
    this.log = options.log;
  }

  /**
   * Restart backoff for this lookup while sharing the delay budget and deadline.
   * Only read operations belong here; mutations must never be retried.
   * @example await visibility.read(readDraft, (release) => release.state !== 'absent');
   */
  async read<T>(
    read: (signal: AbortSignal) => Promise<T>,
    visible: (value: T) => boolean,
    label = 'post-write read',
    describe: (value: T) => string = () => 'not yet visible'
  ): Promise<T> {
    this.startedAt ??= this.now();
    let nextDelay = 0;
    let last = 'no response';
    while (true) {
      let result: T;
      try {
        result = await this.withinDeadline(read, `${label}; last=${last}`);
      } catch (cause) {
        // Do not print arbitrary exception payloads, which can contain credentials.
        this.log?.(
          `Canary visibility failed: ${label}; attempt=${nextDelay + 1}; ${this.timing()}; read rejected`
        );
        throw cause;
      }
      this.lastObservation = `${label}; attempt=${nextDelay + 1}; ${describe(result)}`;
      if (visible(result)) {
        if (nextDelay > 0)
          this.log?.(
            `Canary visibility settled: ${label}; attempt=${nextDelay + 1}; ${describe(result)}; ${this.timing()}`
          );
        return result;
      }
      last = describe(result);
      const configuredDelay = this.delays[nextDelay++];
      if (configuredDelay === undefined || (configuredDelay > 0 && this.remainingWaitMs === 0)) {
        this.log?.(
          `Canary visibility exhausted: ${label}; attempt=${nextDelay}; ${last}; ${this.timing()}`
        );
        return result;
      }
      const delay = Math.min(configuredDelay, this.remainingWaitMs, this.remainingTtl());
      this.remainingWaitMs -= delay;
      this.log?.(
        `Canary visibility retry: ${label}; attempt=${nextDelay}; ${last}; ${this.timing()}; waiting=${delay}ms`
      );
      await this.withinDeadline(() => this.sleep(delay), `${label}; last=${last}`);
    }
  }

  /** Bound one operation without retries, including a publication side effect.
   * @example await visibility.run((signal) => runner.run(command, signal), 'tag write');
   */
  async run<T>(operation: (signal: AbortSignal) => Promise<T>, label: string): Promise<T> {
    this.startedAt ??= this.now();
    return this.withinDeadline(operation, label);
  }

  private remainingTtl(): number {
    return this.ttlMs === undefined
      ? Infinity
      : this.ttlMs - (this.now() - (this.startedAt ?? this.now()));
  }

  private timing(): string {
    return `elapsed=${Math.round(this.now() - (this.startedAt ?? this.now()))}ms; remaining=${this.ttlMs === undefined ? 'delay-only' : `${Math.max(0, Math.round(this.remainingTtl()))}ms`}; TTL=${this.ttlMs ?? 'delay-only'}`;
  }

  private expired(label: string): Error {
    if (this.expiration) return this.expiration;
    const error = new Error(
      `Canary visibility TTL expired: ${label}; last observation=${this.lastObservation}; ${this.timing()}. External effects may exist; rerun with original approved bytes.`
    );
    this.expiration = error;
    this.log?.(error.message);
    return error;
  }

  private async withinDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    label: string
  ): Promise<T> {
    if (this.expiration) throw this.expiration;
    const remaining = this.remainingTtl();
    if (remaining <= 0) throw this.expired(label);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        if (Number.isFinite(remaining))
          timer = setTimeout(() => {
            const error = this.expired(label);
            reject(error);
            controller.abort(error);
          }, Math.ceil(remaining));
      });
      const result = await Promise.race([operation(controller.signal), timeout]);
      if (this.expiration || this.remainingTtl() <= 0) {
        const error = this.expired(label);
        controller.abort(error);
        throw error;
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
