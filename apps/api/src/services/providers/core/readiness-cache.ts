interface CachedEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

interface ReadinessCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 15_000;

/**
 * Short-lived cache for provider readiness work so warmup can overlap with
 * unrelated DB I/O without changing runtime behavior or connector routing.
 */
export function createReadinessCache<T>(options: ReadinessCacheOptions = {}): {
  get: (key: string, loader: () => Promise<T>) => Promise<T>;
  prime: (key: string, loader: () => Promise<T>) => Promise<void>;
  clearWhere: (predicate: (key: string) => boolean) => void;
} {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const cachedEntries = new Map<string, CachedEntry<T>>();
  const inflightEntries = new Map<string, Promise<T>>();

  async function get(key: string, loader: () => Promise<T>): Promise<T> {
    const currentTime = now();
    const cachedEntry = cachedEntries.get(key);
    if (cachedEntry && cachedEntry.expiresAt > currentTime) {
      return cachedEntry.value;
    }

    const inflightEntry = inflightEntries.get(key);
    if (inflightEntry) {
      return inflightEntry;
    }

    const loadPromise = loader()
      .then((value) => {
        cachedEntries.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .finally(() => {
        inflightEntries.delete(key);
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
      }
    }
  }

  return {
    get,
    prime,
    clearWhere,
  };
}
