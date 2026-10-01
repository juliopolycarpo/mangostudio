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
  /** Maximum number of user entries to keep. Oldest entry is evicted when exceeded. Default: 1000. */
  maxEntries?: number;
}

export interface CachedModelFetcher<T> {
  (userId: string): Promise<T[]>;
  invalidate(userId?: string): void;
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
): CachedModelFetcher<T> {
  const now = opts.now ?? (() => Date.now());
  const maxEntries = opts.maxEntries ?? 1000;

  const cache = new Map<string, { value: T[]; expiresAt: number }>();
  const inflight = new Map<string, Promise<T[]>>();

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  const cachedFetch = async function cachedFetch(userId: string): Promise<T[]> {
    // Return cached value if still fresh
    const entry = cache.get(userId);
    if (entry && now() < entry.expiresAt) {
      return entry.value;
    }

    // Deduplicate concurrent calls for the same userId
    const existing = inflight.get(userId);
    if (existing) return existing;

    // The in-flight entry doubles as the invalidation token: `invalidate`
    // removes or replaces it, so a load that no longer owns the entry is stale.
    // `promise` is only read after an await or in a `.finally` callback, both
    // of which run after the assignment below.
    const load = async (): Promise<T[]> => {
      try {
        const models = await fetchFn(userId);
        // A load invalidated mid-flight still answers its own caller, but must
        // not repopulate the shared cache with the pre-invalidation value.
        if (inflight.get(userId) === promise) {
          cache.set(userId, { value: models, expiresAt: now() + opts.ttl });
          if (cache.size > maxEntries) {
            const firstKey = cache.keys().next().value;
            if (firstKey !== undefined) cache.delete(firstKey);
          }
        }
        return models;
      } catch {
        // On error, return stale cache if available, otherwise fallback
        const stale = cache.get(userId);
        return stale ? stale.value : opts.fallback;
      }
    };

    const promise: Promise<T[]> = load().finally(() => {
      // Only remove our own entry; a replacement loader may own the key now.
      if (inflight.get(userId) === promise) inflight.delete(userId);
    });

    inflight.set(userId, promise);
    return promise;
  };

  cachedFetch.invalidate = (userId?: string): void => {
    if (userId) {
      cache.delete(userId);
      inflight.delete(userId);
      return;
    }

    cache.clear();
    inflight.clear();
  };

  return cachedFetch;
}
