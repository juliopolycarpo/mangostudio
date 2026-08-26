/**
 * A ~60 second read-through cache in front of every GitHub read.
 *
 * Each of these endpoints is a live round trip through `gh` to GitHub's API on
 * whatever machine the runtime is on, and the panel asks several of them at
 * once whenever a tab changes. Without a cache, switching between "PRs" and
 * "Issues" twice is four network calls against a rate-limited API.
 *
 * Built on `createReadinessCache` rather than a new cache, because the three
 * properties that matter here — a TTL, in-flight deduplication so a burst of
 * tab switches makes one call, and `clearWhere` so a write can drop what it
 * invalidated — are exactly what that one already has.
 *
 * The key is compound for the same reason `git-batch-status-service` keys by
 * `${environmentId}\0${workdir}`: a GitHub answer is about one repository, on
 * one machine, for one account. `\0` separates the segments because it is the
 * one byte none of them can contain.
 */

import { createReadinessCache } from '../../../services/providers/core/readiness-cache';

/** Long enough that a tab switch is free, short enough that a merged PR disappears. */
const GITHUB_CACHE_TTL_MS = 60_000;

/** The `(user, machine, repository)` a cached answer belongs to. */
export interface GithubCacheScope {
  readonly userId: string;
  readonly environmentId: string;
  /** The workdir for a repository read; `inbox` for the cross-repo search. */
  readonly subject: string;
}

export interface GithubCache {
  /** Returns a cached payload or loads and caches one. */
  readonly read: <T>(
    scope: GithubCacheScope,
    variant: string,
    load: () => Promise<T>
  ) => Promise<T>;
  /**
   * Drops every entry for one machine.
   *
   * Deliberately coarser than the key: a `pr create` changes the PR list, and a
   * `pr checkout` changes the list, the detail, the checks and the branch every
   * other read is relative to. Enumerating which of those a write touched would
   * be a second copy of the truth that goes stale; at a 60s TTL, dropping the
   * machine costs one extra `gh` call and can never show a list that disagrees
   * with the action the user just took.
   */
  readonly clear: (scope: Pick<GithubCacheScope, 'userId' | 'environmentId'>) => void;
}

export interface CreateGithubCacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Creates one cache for every GitHub read.
 *
 * @example
 * const cache = createGithubCache();
 * await cache.read({ userId, environmentId, subject: workdir }, 'prs:open:20', loadPrs);
 */
export function createGithubCache(options: CreateGithubCacheOptions = {}): GithubCache {
  // `unknown` because one cache holds every endpoint's payload; the typed
  // `read<T>` below is the seam that keeps callers from having to know that.
  const cache = createReadinessCache<unknown>({
    ttlMs: options.ttlMs ?? GITHUB_CACHE_TTL_MS,
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    read: <T>(scope: GithubCacheScope, variant: string, load: () => Promise<T>): Promise<T> =>
      cache.get(cacheKey(scope, variant), load) as Promise<T>,
    clear: (scope) => {
      const prefix = machinePrefix(scope.userId, scope.environmentId);
      cache.clearWhere((key) => key.startsWith(prefix));
    },
  };
}

/** The process-wide cache the routes use; tests inject their own. */
export const githubCache = createGithubCache();

function cacheKey(scope: GithubCacheScope, variant: string): string {
  return `${machinePrefix(scope.userId, scope.environmentId)}${scope.subject}\0${variant}`;
}

function machinePrefix(userId: string, environmentId: string): string {
  return `${userId}\0${environmentId}\0`;
}
