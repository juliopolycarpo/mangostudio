import { isMainCacheWriter, retryIncompleteListing, type RustCacheApi } from './github';
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

function stillSelected(plan: RustCacheDeletion, entries: readonly RustCacheEntry[]): boolean {
  return selectRustCacheDeletions(entries).some(
    (fresh) =>
      unchangedEntry(plan.entry, fresh.entry) && unchangedEntry(plan.replacement, fresh.replacement)
  );
}

/**
 * Prune committed generations after a trusted main writer completes. Recheck
 * the active writers and both exact IDs before each individual deletion.
 * @example await cleanupRustCaches(api, { repository: 'owner/repo', runId: 42, apply: true });
 */
export async function cleanupRustCaches(
  api: RustCacheApi,
  context: { readonly repository: string; readonly runId: number; readonly apply: boolean }
): Promise<RustCacheCleanupResult> {
  const trigger = await api.getRun(context.runId);
  if (!isMainCacheWriter(trigger, context.repository) || trigger.status !== 'completed') {
    throw new Error(
      `Invalid cleanup trigger ${trigger.id} ${trigger.event} ${trigger.head_branch} ${trigger.path} ${trigger.status}; expected a completed same-repository main writer`
    );
  }
  const planned = selectRustCacheDeletions(
    await retryIncompleteListing('actions_caches', () => api.listCaches())
  );
  const deletedIds: number[] = [];
  if (!context.apply) return { planned, deletedIds, deferred: null };

  for (const plan of planned) {
    // Restart the writer audit if the cache listing needs a fresh read.
    const deferred = await retryIncompleteListing('actions_caches', async () => {
      const active = await api.activeWriters();
      if (active.length > 0)
        return `Active main cache writers: ${active.map((run) => run.id).join(', ')}`;
      if (!stillSelected(plan, await api.listCaches()))
        return `Cache ${plan.entry.id} or replacement ${plan.replacement.id} changed or disappeared`;
      return null;
    });
    if (deferred !== null) return { planned, deletedIds, deferred };

    if (await api.deleteCache(plan.entry.id)) deletedIds.push(plan.entry.id);
    const after = await retryIncompleteListing('actions_caches', () => api.listCaches());
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
