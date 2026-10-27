interface CachedEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

interface ReadinessCacheOptions {
  ttlMs?: number;
  now?: () => number;
  onHit?: (key: string) => void;
  onMiss?: (key: string) => void;
}

const DEFAULT_TTL_MS = 15_000;

export function createReadinessCacheKey(userId: string, modelName?: string): string {
  return `${userId}\u0000${modelName ?? ''}`;
}

/**
 * Short-lived cache for provider readiness work so warmup can overlap with
 * unrelated DB I/O without changing runtime behavior or connector routing.
 */
export function createReadinessCache<T>(options: ReadinessCacheOptions = {}): {
  get: (key: string, loader: () => Promise<T>) => Promise<T>;
  prime: (key: string, loader: () => Promise<T>) => Promise<void>;
  clearWhere: (predicate: (key: string) => boolean) => void;
  clearByUserPrefix: (userId: string) => void;
} {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const onHit = options.onHit;
  const onMiss = options.onMiss;
  const cachedEntries = new Map<string, CachedEntry<T>>();
  const inflightEntries = new Map<string, Promise<T>>();
  // Bumped for a key whenever a load in flight for it is cleared, so that
  // load's own `.then()` — already running, with no way to cancel it — can
  // tell it was invalidated after it started and skip writing its answer
  // into `cachedEntries`. Without this, `clear`/`clearWhere` only removes the
  // in-flight bookkeeping; the loader's callback still resolves afterward and
  // silently re-populates the cache with the pre-clear answer.
  const generations = new Map<string, number>();

  // Migrated from ESLint
  async function get(key: string, loader: () => Promise<T>): Promise<T> {
    const currentTime = now();
    const cachedEntry = cachedEntries.get(key);
    if (cachedEntry && cachedEntry.expiresAt > currentTime) {
      onHit?.(key);
      return cachedEntry.value;
    }

    const inflightEntry = inflightEntries.get(key);
    if (inflightEntry) {
      onHit?.(key);
      return inflightEntry;
    }

    onMiss?.(key);

    const startedAtGeneration = generations.get(key) ?? 0;
    const loadPromise = loader()
      .then((value) => {
        if ((generations.get(key) ?? 0) === startedAtGeneration) {
          cachedEntries.set(key, { value, expiresAt: now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
        // Only remove our own entry; a replacement load may own the key after
        // a clear, and deleting it would defeat deduplication.
        if (inflightEntries.get(key) === loadPromise) inflightEntries.delete(key);
      });

    inflightEntries.set(key, loadPromise);
    return loadPromise;
  }

  async function prime(key: string, loader: () => Promise<T>): Promise<void> {
    await get(key, loader);
  }

  function clearWhere(predicate: (key: string) => boolean): void {
    for (const key of cachedEntries.keys()) {
      if (predicate(key)) {
        cachedEntries.delete(key);
      }
    }

    for (const key of inflightEntries.keys()) {
      if (predicate(key)) {
        inflightEntries.delete(key);
        generations.set(key, (generations.get(key) ?? 0) + 1);
      }
    }
  }

  function clearByUserPrefix(userId: string): void {
    const prefix = `${userId}\u0000`;
    clearWhere((key) => key.startsWith(prefix));
  }

  return {
    get,
    prime,
    clearWhere,
    clearByUserPrefix,
  };
}
