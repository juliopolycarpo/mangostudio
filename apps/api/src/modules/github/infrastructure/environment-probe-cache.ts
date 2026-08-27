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

import { createReadinessCache } from '../../../services/providers/core/readiness-cache';

/** Identifies the runtime a probe ran against. */
export interface ProbeEnvironmentKey {
  readonly userId: string;
  readonly environmentId: string;
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
  // The TTL and the in-flight deduplication are `createReadinessCache`'s job,
  // the same one `github-cache.ts` reuses it for. Folding the rejection into
  // `false` inside the loader rather than around the cache is what makes a
  // failure cache and expire on the same clock as a success: the cache only
  // ever sees a resolved boolean.
  const cache = createReadinessCache<boolean>({ ttlMs: options.ttlMs, now: options.now });

  return (key) =>
    cache.get(`${key.userId}:${key.environmentId}`, () =>
      options.probe(key).then(
        () => true,
        () => false
      )
    );
}
