const DEFAULT_MAX_CACHE_ENTRIES = 128;

/**
 * Reuse long-lived SDK clients so upstream HTTP transports can keep warm
 * connections without changing provider request semantics.
 */
export function getOrCreateCachedClient<T>(
  cache: Map<string, T>,
  cacheKey: string,
  factory: () => T
): T {
  const cachedClient = cache.get(cacheKey);
  if (cachedClient) {
    return cachedClient;
  }

  const client = factory();

  if (cache.size >= DEFAULT_MAX_CACHE_ENTRIES) {
    const oldestCacheKey = cache.keys().next().value;
    if (oldestCacheKey !== undefined) {
      cache.delete(oldestCacheKey);
    }
  }

  cache.set(cacheKey, client);
  return client;
}
