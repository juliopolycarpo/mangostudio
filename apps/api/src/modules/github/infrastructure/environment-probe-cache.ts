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
  /**
   * Resolves to the verdict once the probe ran to completion, `false` included.
   * Rejects when it could not — a timeout, a dropped connection, a cancelled
   * request — because then there is no verdict to give.
   */
  readonly probe: (key: ProbeEnvironmentKey) => Promise<boolean>;
  readonly now: () => number;
  readonly ttlMs: number;
}

/**
 * Wraps a probe so repeated asks within the TTL are free and concurrent asks
 * share one call.
 *
 * Only a verdict is cached. A rejection passes through untouched and is not
 * remembered, because a probe that failed to run has not learned anything about
 * the machine: caching it as `false` would report a slow SSH host as signed
 * out, with advice to run `gh auth login`, for the whole TTL. A cached verdict
 * expires on the same clock whichever way it went, so an operator who installs
 * `gh` or runs `gh auth login` recovers without restarting the hub.
 *
 * @example
 * const isAuthed = createEnvironmentProbeCache({ probe, now: Date.now, ttlMs: 60_000 });
 * await isAuthed({ userId: 'u1', environmentId: 'local' });
 */
export function createEnvironmentProbeCache(
  options: EnvironmentProbeCacheOptions
): (key: ProbeEnvironmentKey) => Promise<boolean> {
  // The TTL and the in-flight deduplication are `createReadinessCache`'s job,
  // the same one `github-cache.ts` reuses it for. It stores a loader's value
  // only when the loader resolves, which is what keeps a failed probe out.
  const cache = createReadinessCache<boolean>({ ttlMs: options.ttlMs, now: options.now });

  return (key) => cache.get(`${key.userId}:${key.environmentId}`, () => options.probe(key));
}
