/**
 * Generic model-list cache factory.
 * Wraps a provider's listModels() call with TTL caching, deduplication of concurrent
 * fetches, and a fallback value for when the fetch fails.
 */

export interface ModelCacheOptions<T> {
  /** Time-to-live in milliseconds before the cache is considered stale. */
  ttl: number;
  /** Value returned when fetchFn throws and no prior cache entry exists. */
  fallback: T[];
  /** Injected clock (useful in tests). */
  now?: () => number;
}

/**
 * Returns a cached-fetch function with TTL and concurrent-request deduplication.
 *
 * Usage:
 *   const listWithCache = withModelCache(
 *     (userId) => reallyFetchModels(userId),
 *     { ttl: 3_600_000, fallback: FALLBACK_MODELS }
 *   );
 *   const models = await listWithCache(userId);
 */
export function withModelCache<T>(
  fetchFn: (userId: string) => Promise<T[]>,
  opts: ModelCacheOptions<T>
): (userId: string) => Promise<T[]> {
  const now = opts.now ?? (() => Date.now());

  const cache = new Map<string, { value: T[]; expiresAt: number }>();
  const inflight = new Map<string, Promise<T[]>>();

  return async function cachedFetch(userId: string): Promise<T[]> {
    // Return cached value if still fresh
    const entry = cache.get(userId);
    if (entry && now() < entry.expiresAt) {
      return entry.value;
    }

    // Deduplicate concurrent calls for the same userId
    const existing = inflight.get(userId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const models = await fetchFn(userId);
        cache.set(userId, { value: models, expiresAt: now() + opts.ttl });
        return models;
      } catch {
        // On error, return stale cache if available, otherwise fallback
        const stale = cache.get(userId);
        return stale ? stale.value : opts.fallback;
      } finally {
        inflight.delete(userId);
      }
    })();

    inflight.set(userId, promise);
    return promise;
  };
}
