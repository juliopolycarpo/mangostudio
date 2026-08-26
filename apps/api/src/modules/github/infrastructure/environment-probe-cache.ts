/**
 * A TTL-bounded boolean probe, cached and single-flighted per environment.
 *
 * The thing being cached is a fact about a *machine* — "is this user signed in
 * to gh over there" — so the cache key is the machine, not the directory the
 * question happened to be asked from. The implementation this replaced took a
 * `cwd` and then keyed by nothing at all, which meant one boolean answered for
 * every workdir *and* every environment: a signed-in laptop made a signed-out
 * container look authenticated.
 */

/** Identifies the runtime a probe ran against. */
export interface ProbeEnvironmentKey {
  readonly userId: string;
  readonly environmentId: string;
}

interface CacheEntry {
  readonly value: boolean;
  readonly expiresAt: number;
}

export interface EnvironmentProbeCacheOptions {
  readonly probe: (key: ProbeEnvironmentKey) => Promise<unknown>;
  readonly now: () => number;
  readonly ttlMs: number;
}

/**
 * Wraps a probe so repeated asks within the TTL are free and concurrent asks
 * share one call.
 *
 * A probe that rejects caches `false` and expires on the same clock as a
 * success, so an operator who installs `gh` or runs `gh auth login` recovers
 * without restarting the hub.
 *
 * @example
 * const isAuthed = createEnvironmentProbeCache({ probe, now: Date.now, ttlMs: 60_000 });
 * await isAuthed({ userId: 'u1', environmentId: 'local' });
 */
export function createEnvironmentProbeCache(
  options: EnvironmentProbeCacheOptions
): (key: ProbeEnvironmentKey) => Promise<boolean> {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<boolean>>();

  return (key) => {
    const id = `${key.userId}:${key.environmentId}`;
    const cached = cache.get(id);
    if (cached && options.now() < cached.expiresAt) return Promise.resolve(cached.value);

    const existing = inFlight.get(id);
    if (existing) return existing;

    const pending = options
      .probe(key)
      .then(
        () => true,
        () => false
      )
      .then((value) => {
        cache.set(id, { value, expiresAt: options.now() + options.ttlMs });
        return value;
      })
      .finally(() => {
        inFlight.delete(id);
      });
    inFlight.set(id, pending);
    return pending;
  };
}
