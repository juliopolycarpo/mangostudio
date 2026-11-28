import type { GitHubRetry } from '../../lib/github-retry';
import { isMainCacheWriter, type RustCacheApi } from './github';
import { RETENTION_DELETIONS_PER_RUN, selectRetentionDeletions } from './retention';
import { type RustCacheDeletion, type RustCacheEntry, selectRustCacheDeletions } from './selection';

export interface RustCacheCleanupResult {
  readonly planned: readonly RustCacheDeletion[];
  readonly deletedIds: readonly number[];
  readonly deferred: string | null;
}

function unchangedEntry(expected: RustCacheEntry, actual: RustCacheEntry | undefined): boolean {
  return (
    expected.id === actual?.id &&
    expected.key === actual.key &&
    expected.ref === actual.ref &&
    expected.version === actual.version &&
    expected.created_at === actual.created_at &&
    expected.size_in_bytes === actual.size_in_bytes
  );
}

/**
 * Every deletion both rules select: superseded Rust generations, then the retention rule's entries
 * beyond the newest few of each lane. Throws on an unrecognised key in a retained family.
 * @example selectCacheDeletions(listing, Date.now());
 */
export function selectCacheDeletions(
  entries: readonly RustCacheEntry[],
  now: number
): RustCacheDeletion[] {
  return [...selectRustCacheDeletions(entries), ...selectRetentionDeletions(entries, now)];
}

/**
 * What one run attempts: all Rust deletions and the oldest `RETENTION_DELETIONS_PER_RUN`
 * retention ones. The cap keeps a first run over a large backlog inside the token's request
 * budget; a revalidation uses the uncapped `selectCacheDeletions`, since deleting the entries
 * ahead of one only moves it closer to the front.
 * @example planCacheDeletions(listing, Date.now());
 */
export function planCacheDeletions(
  entries: readonly RustCacheEntry[],
  now: number
): RustCacheDeletion[] {
  return [
    ...selectRustCacheDeletions(entries),
    ...selectRetentionDeletions(entries, now).slice(0, RETENTION_DELETIONS_PER_RUN),
  ];
}

function stillSelected(
  plan: RustCacheDeletion,
  entries: readonly RustCacheEntry[],
  now: number
): boolean {
  return selectCacheDeletions(entries, now).some(
    (fresh) =>
      unchangedEntry(plan.entry, fresh.entry) && unchangedEntry(plan.replacement, fresh.replacement)
  );
}

/** One writer audit plus revalidation of the planned pair: a deferral reason, or null to delete. */
async function auditPass(
  api: RustCacheApi,
  plan: RustCacheDeletion,
  now: number
): Promise<string | null> {
  const active = await api.activeWriters();
  if (active.length > 0)
    return `Active main cache writers: ${active.map((run) => run.id).join(', ')}`;
  if (!stillSelected(plan, await api.listCaches(), now))
    return `Cache ${plan.entry.id} or replacement ${plan.replacement.id} changed or disappeared`;
  return null;
}

/**
 * Prune committed generations and retained-family entries after a trusted main writer completes.
 * Recheck the active writers and both exact IDs before each individual deletion. `now` is
 * injectable so the retention rule's quiet window is testable without a clock.
 * An unrecognised key in a retained family throws before any deletion.
 * A listing that comes back incomplete is read again from the start, at most
 * three passes in all; a listing that stays incomplete fails and deletes nothing.
 * `retry` must be the runtime the `api` was built with: requests and listing
 * passes then spend one 60 s wait budget for the whole run (the 15-minute step
 * has room), and a pass that slept re-audits before any deletion.
 * @example await cleanupRustCaches(api, { repository: 'owner/repo', runId: 42, apply: true, retry });
 */
export async function cleanupRustCaches(
  api: RustCacheApi,
  context: {
    readonly repository: string;
    readonly runId: number;
    readonly apply: boolean;
    readonly retry: GitHubRetry;
    readonly now?: () => number;
  }
): Promise<RustCacheCleanupResult> {
  const { retry } = context;
  const clock = context.now ?? Date.now;
  const trigger = await api.getRun(context.runId);
  if (!isMainCacheWriter(trigger, context.repository) || trigger.status !== 'completed') {
    throw new Error(
      `Invalid cleanup trigger ${trigger.id} ${trigger.event} ${trigger.head_branch} ${trigger.path} ${trigger.status}; expected a completed same-repository main writer`
    );
  }
  const planned = planCacheDeletions(
    await retry.listing('main cache listing', () => api.listCaches()),
    clock()
  );
  const deletedIds: number[] = [];
  if (!context.apply) return { planned, deletedIds, deferred: null };

  for (const plan of planned) {
    // One retry level for the audit and the listing it guards: a fresh read of
    // the listing restarts the writer audit too, since a writer may have
    // started while the retry waited.
    const deferred = await retry.listing('writer audit and cache revalidation', async () => {
      for (;;) {
        const waitedBefore = retry.waitedMs;
        const verdict = await auditPass(api, plan, clock());
        // A request inside the pass slept and then succeeded: the audit may be
        // tens of seconds old, so the DELETE must not rest on it. A deferral is
        // safe to return as it is. Every repeat spends the shared wait budget,
        // so this loop ends.
        if (verdict !== null || retry.waitedMs === waitedBefore) return verdict;
      }
    });
    if (deferred !== null) return { planned, deletedIds, deferred };

    if (await api.deleteCache(plan.entry.id)) deletedIds.push(plan.entry.id);
    const after = await retry.listing('Rust cache listing after deletion', () => api.listCaches());
    if (
      !unchangedEntry(
        plan.replacement,
        after.find((entry) => entry.id === plan.replacement.id)
      )
    ) {
      throw new Error(
        `Replacement cache ${plan.replacement.id} ${plan.replacement.key} disappeared after deletion; expected it to remain, refusing further cleanup`
      );
    }
  }
  return { planned, deletedIds, deferred: null };
}
