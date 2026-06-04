/**
 * In-memory request counters for the rate limiter, bounded by entry count.
 *
 * Split from the Elysia plugin so the storage and eviction policy can be
 * unit-tested in isolation. Single-process only — see the NOTE in rate-limit.ts
 * for multi-instance deployments.
 */

/** A per-key request counter and the epoch-ms instant its window resets. */
export interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/** Bounded map of `key → RateLimitEntry` with expiry and overflow eviction. */
export class RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();

  /** @param maxSize - Hard cap on retained keys; oldest are evicted past it. */
  constructor(private readonly maxSize: number) {}

  /** Number of retained counter entries. // Usage: store.size */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Increment the counter for `key`, starting a fresh window when it is absent
   * or expired. Returns the live entry so callers can read count/resetTime.
   * // Usage: store.touch('rate-limit:general:1.2.3.4', 60_000, Date.now())
   */
  touch(key: string, windowMs: number, now: number): RateLimitEntry {
    const existing = this.entries.get(key);
    if (!existing || existing.resetTime < now) {
      const entry: RateLimitEntry = { count: 1, resetTime: now + windowMs };
      this.entries.set(key, entry);
      return entry;
    }
    existing.count++;
    return existing;
  }

  /** Drop entries whose window has elapsed. // Usage: store.removeExpired(Date.now()) */
  removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetTime < now) this.entries.delete(key);
    }
  }

  /**
   * Evict the oldest entries until at or below `maxSize`. Costs O(overflow) and
   * no-ops while under the cap, so it is cheap to call on every request. Bounds
   * memory against key floods (e.g. spoofed forwarded IPs) between the timed
   * `removeExpired` sweeps. // Usage: store.evictOverflow()
   */
  evictOverflow(): void {
    let overflow = this.entries.size - this.maxSize;
    if (overflow <= 0) return;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      if (--overflow <= 0) break;
    }
  }

  /** Drop all entries (tests / graceful shutdown). // Usage: store.clear() */
  clear(): void {
    this.entries.clear();
  }
}
