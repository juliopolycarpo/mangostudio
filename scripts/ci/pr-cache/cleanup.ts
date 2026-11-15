import {
  type ActionsCacheEntry,
  retryIncompleteListing,
  retryUnstableListing,
} from '../actions-api/client';
import type { PullRequestCacheApi } from './github';
import {
  pullRequestMergeRef,
  pullRequestNumberOfRef,
  pullRequestNumbers,
  type PullRequestState,
  selectClosedPullRequestCaches,
  selectPullRequestCaches,
} from './selection';

export interface PullRequestCacheCleanupResult {
  /** False for a dry run: nothing was deleted. */
  readonly apply: boolean;
  readonly planned: readonly ActionsCacheEntry[];
  readonly deletedIds: readonly number[];
  /** Planned IDs whose DELETE answered 404. */
  readonly alreadyGoneIds: readonly number[];
  /** Sweep only: pull requests with caches that were left alone, by reason. */
  readonly skipped: {
    readonly open: readonly number[];
    readonly unknown: readonly number[];
  };
}

const NO_SKIPPED = { open: [], unknown: [] } as const;

async function deletePlanned(
  api: PullRequestCacheApi,
  planned: readonly ActionsCacheEntry[],
  apply: boolean,
  skipped: PullRequestCacheCleanupResult['skipped'] = NO_SKIPPED
): Promise<PullRequestCacheCleanupResult> {
  const deletedIds: number[] = [];
  const alreadyGoneIds: number[] = [];
  if (apply) {
    for (const entry of planned) {
      try {
        // A 404 means eviction or a concurrent cleanup got there first.
        const deleted = await api.deleteCache(entry.id);
        (deleted ? deletedIds : alreadyGoneIds).push(entry.id);
      } catch (error) {
        // A large sweep can exhaust the token's rate limit midway. Name the
        // progress so the run log shows what was already deleted; a re-run
        // lists the remainder, because deleted caches no longer appear.
        const deletedBytes = planned
          .filter((planned) => deletedIds.includes(planned.id))
          .reduce((sum, planned) => sum + planned.size_in_bytes, 0);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${reason}; deleted ${deletedIds.length} of ${planned.length} caches (${deletedBytes} bytes) before stopping, re-run to continue`,
          { cause: error }
        );
      }
    }
  }
  return { apply, planned, deletedIds, alreadyGoneIds, skipped };
}

/**
 * Delete every cache saved under one pull request's merge ref, and nothing
 * saved under any other ref. Without `apply` it only plans. A pull request that
 * is open (reopened before this ran) or unknown to GitHub keeps its caches.
 * @example await cleanupPullRequestCaches(api, 2222, { apply: true });
 */
export async function cleanupPullRequestCaches(
  api: PullRequestCacheApi,
  pullRequest: number,
  options: { readonly apply: boolean }
): Promise<PullRequestCacheCleanupResult> {
  const ref = pullRequestMergeRef(pullRequest);
  const state = await api.pullRequestState(pullRequest);
  if (state !== 'closed') {
    const skipped =
      state === 'open'
        ? { open: [pullRequest], unknown: [] }
        : { open: [], unknown: [pullRequest] };
    return deletePlanned(api, [], options.apply, skipped);
  }
  const listed = await retryIncompleteListing('actions_caches', () => api.listCachesOnRef(ref));
  return deletePlanned(api, selectPullRequestCaches(listed, pullRequest), options.apply);
}

/**
 * Delete the merge-ref caches of every closed pull request. Open pull requests
 * and numbers GitHub does not know keep their caches.
 * @example await sweepClosedPullRequestCaches(api, { apply: false });
 */
export async function sweepClosedPullRequestCaches(
  api: PullRequestCacheApi,
  options: { readonly apply: boolean }
): Promise<PullRequestCacheCleanupResult> {
  // Other jobs save and delete caches while this pages through the whole
  // repository. A stale plan is harmless: a vanished cache answers 404 and a
  // newer one waits for the next sweep.
  const listed = await retryUnstableListing(() =>
    retryIncompleteListing('actions_caches', () => api.listAllCaches())
  );
  const states = new Map<number, PullRequestState>();
  const unknown: number[] = [];
  for (const number of pullRequestNumbers(listed)) {
    const state = await api.pullRequestState(number);
    if (state) states.set(number, state);
    else unknown.push(number);
  }
  const open = [...states].filter(([, state]) => state === 'open').map(([number]) => number);
  return deletePlanned(api, selectClosedPullRequestCaches(listed, states), options.apply, {
    open,
    unknown,
  });
}

/**
 * Plain-text report: per pull request counts and bytes, then totals.
 * @example console.log(formatPullRequestCacheReport(result));
 */
export function formatPullRequestCacheReport(result: PullRequestCacheCleanupResult): string {
  const perPullRequest = new Map<number, { count: number; bytes: number }>();
  for (const entry of result.planned) {
    const number = pullRequestNumberOfRef(entry.ref) as number;
    const total = perPullRequest.get(number) ?? { count: 0, bytes: 0 };
    perPullRequest.set(number, {
      count: total.count + 1,
      bytes: total.bytes + entry.size_in_bytes,
    });
  }
  const plannedBytes = result.planned.reduce((sum, entry) => sum + entry.size_in_bytes, 0);
  const deletedBytes = result.planned
    .filter((entry) => result.deletedIds.includes(entry.id))
    .reduce((sum, entry) => sum + entry.size_in_bytes, 0);
  const lines = [
    result.apply
      ? 'Pull request cache cleanup'
      : 'Pull request cache cleanup (dry run, nothing deleted)',
    ...[...perPullRequest].map(
      ([number, { count, bytes }]) => `  PR #${number}: ${count} caches, ${bytes} bytes`
    ),
    `Planned: ${result.planned.length} caches, ${plannedBytes} bytes across ${perPullRequest.size} pull requests`,
  ];
  if (result.apply) {
    lines.push(
      `Deleted: ${result.deletedIds.length} caches, ${deletedBytes} bytes`,
      `Already gone: ${result.alreadyGoneIds.length} caches`
    );
  }
  if (result.skipped.open.length > 0 || result.skipped.unknown.length > 0) {
    lines.push(
      `Left alone: ${result.skipped.open.length} open pull requests, ${result.skipped.unknown.length} with an unknown state`
    );
  }
  return lines.join('\n');
}
