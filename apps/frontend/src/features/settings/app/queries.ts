import {
  type AppSettings,
  type AppSettingsResponse,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
} from '@mangostudio/shared/app-settings';
import { type QueryClient, queryOptions } from '@tanstack/react-query';

import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export const appSettingsKeys = {
  all: ['app-settings'] as const,
  current: () => [...appSettingsKeys.all, 'current'] as const,
  /** Mutation key: lets the layout observe auto-save state it does not own. */
  save: () => [...appSettingsKeys.all, 'save'] as const,
};

export type AppSettingsCache = AppSettings &
  Partial<Pick<AppSettingsResponse, 'revision' | 'libraryLocationDefaultsPending'>>;

const confirmedCacheWrites = new WeakMap<object, number>();
const latestSubmittedWrites = new WeakMap<QueryClient, number>();
let writeSequence = 0;

/** Identify the confirmed write an optimistic cache entry extends.
 * @example const baseline = appSettingsConfirmedWrite(cached);
 */
export function appSettingsConfirmedWrite(settings: object | undefined): number | undefined {
  return settings === undefined ? undefined : confirmedCacheWrites.get(settings);
}

/** Retain confirmed provenance when a local edit replaces a cache object.
 * @example inheritAppSettingsWrite(cached, optimistic);
 */
export function inheritAppSettingsWrite(
  source: object | undefined,
  target: object | undefined
): void {
  const write = appSettingsConfirmedWrite(source);
  if (write !== undefined && target !== undefined) confirmedCacheWrites.set(target, write);
}

/** Coordinate publication across every app-settings mutation owner sharing a cache.
 * @example const write = beginAppSettingsWrite(queryClient); await write.publish(saved);
 */
export function beginAppSettingsWrite(queryClient: QueryClient) {
  const order = ++writeSequence;
  latestSubmittedWrites.set(queryClient, order);
  const isLatest = () => latestSubmittedWrites.get(queryClient) === order;
  return {
    order,
    isLatest,
    async publish(settings: AppSettingsCache): Promise<AppSettingsCache | undefined> {
      if (!isLatest()) return undefined;
      await queryClient.cancelQueries({ queryKey: appSettingsKeys.current() }, { revert: false });
      if (!isLatest()) return undefined;
      const cached = queryClient.setQueryData<AppSettingsCache>(
        appSettingsKeys.current(),
        keepAppSettingsMetadata(settings, normalizeAppSettings(settings))
      );
      if (cached) confirmedCacheWrites.set(cached, order);
      return cached;
    },
    async reject(error: unknown): Promise<void> {
      if (isLatest()) await refreshAppSettingsAfterConflict(queryClient, error);
      else if (isAppSettingsConflict(error)) recordAppSettingsConflict(queryClient, order);
    },
  };
}

export function appSettingsQueryOptions() {
  return queryOptions({
    queryKey: appSettingsKeys.current(),
    staleTime: 30_000,
    // Either shape: a read answers with the pending flag, while a write's
    // answer lands here normalized and without one (see
    // `libraryLocationDefaultsPending`).
    queryFn: async (): Promise<AppSettingsCache> => {
      const { data, error } = await client.api.settings.app.get();
      if (error) throw new ApiError(error.value);
      // The normalizer only knows stored preferences, so the flag describing
      // this answer is carried across it explicitly.
      return keepAppSettingsMetadata(
        data ?? undefined,
        normalizeAppSettings(data ?? DEFAULT_APP_SETTINGS)
      );
    },
  });
}

/**
 * Whether these app settings still carry placeholder library-location
 * defaults because the hub has not finished detecting its agent CLIs. A cache
 * entry a write produced has no flag and is never pending: `PUT` waits for
 * detection before it answers.
 *
 * @example
 * if (libraryLocationDefaultsPending(query.data)) return <Detecting />;
 */
export function libraryLocationDefaultsPending(settings: object | undefined): boolean {
  if (settings === undefined || !('libraryLocationDefaultsPending' in settings)) return false;
  return settings.libraryLocationDefaultsPending === true;
}

/**
 * Carries response revision and pending-default metadata over to normalized settings. For a client-side
 * rewrite of the cache (an optimistic edit, its rollback) that normalized the
 * flag away: dropped, it would make placeholder library-location defaults read
 * as detected until the next refetch, and a location write would store them.
 *
 * @example
 * queryClient.setQueryData(key, keepAppSettingsMetadata(cached, nextSettings));
 */
export function keepAppSettingsMetadata(
  source: object | undefined,
  settings: AppSettings
): AppSettingsCache {
  const revision = appSettingsRevision(source);
  const pending =
    source !== undefined &&
    'libraryLocationDefaultsPending' in source &&
    typeof source.libraryLocationDefaultsPending === 'boolean'
      ? source.libraryLocationDefaultsPending
      : undefined;
  if (revision === undefined && pending === undefined) return settings;
  return {
    ...settings,
    ...(revision === undefined ? {} : { revision }),
    ...(pending === undefined ? {} : { libraryLocationDefaultsPending: pending }),
  };
}

/** Read the response's opaque revision without treating a preference as metadata.
 * @example await updateAppSettings(patch, appSettingsRevision(snapshot));
 */
export function appSettingsRevision(settings: object | undefined): string | undefined {
  return settings !== undefined && 'revision' in settings && typeof settings.revision === 'string'
    ? settings.revision
    : undefined;
}

/**
 * The app settings a library-location write may build its full location map
 * on. Never the pending placeholder: every location in that map travels as an
 * explicit value, so writing it would store the placeholder for good. Refetches
 * once when the cache is pending, and refuses if the hub is still detecting.
 *
 * @example
 * const locations = libraryLocationsFor(await appSettingsForLocationWrite(queryClient));
 */
export async function appSettingsForLocationWrite(
  queryClient: QueryClient
): Promise<AppSettingsCache> {
  const cached = queryClient.getQueryData<AppSettings | AppSettingsResponse>(
    appSettingsKeys.current()
  );
  if (
    cached !== undefined &&
    !libraryLocationDefaultsPending(cached) &&
    !queryClient.getQueryState(appSettingsKeys.current())?.isInvalidated
  ) {
    return keepAppSettingsMetadata(cached, normalizeAppSettings(cached));
  }
  const fetched = await queryClient.fetchQuery({ ...appSettingsQueryOptions(), staleTime: 0 });
  if (!libraryLocationDefaultsPending(fetched))
    return keepAppSettingsMetadata(fetched, normalizeAppSettings(fetched));
  throw new Error(
    'expected app settings with detected library-location defaults | received: libraryLocationDefaultsPending: true (the hub is still detecting installed agent CLIs)'
  );
}

// A refetch clears isInvalidated, but must not make another mounted
// auto-save owner's already-queued snapshot valid again. Weak ownership keeps
// this coordination scoped to the same cache and its lifetime.
const conflictEpochs = new WeakMap<
  QueryClient,
  { epoch: number; refreshEpoch: number; rejectedWrite: number }
>();

/**
 * The conflict generation a queued app-settings snapshot was built against.
 * @example const epoch = appSettingsConflictEpoch(queryClient);
 */
export function appSettingsConflictEpoch(queryClient: QueryClient): number {
  return conflictEpochs.get(queryClient)?.epoch ?? 0;
}

/**
 * Reject older queues. A superseded request identifies its submission, so a
 * queue derived from a later confirmed write may survive without a refetch.
 * @example recordAppSettingsConflict(queryClient);
 */
export function recordAppSettingsConflict(queryClient: QueryClient, rejectedWrite?: number): void {
  const previous = conflictEpochs.get(queryClient);
  const epoch = (previous?.epoch ?? 0) + 1;
  conflictEpochs.set(queryClient, {
    epoch,
    refreshEpoch: rejectedWrite !== undefined ? (previous?.refreshEpoch ?? 0) : epoch,
    rejectedWrite: Math.max(previous?.rejectedWrite ?? 0, rejectedWrite ?? 0),
  });
}

/**
 * A queue must survive every refresh boundary, even if a later save succeeds.
 * @example const canSave = appSettingsQueueCanSave(queryClient, epoch, confirmedWrite);
 */
export function appSettingsQueueCanSave(
  queryClient: QueryClient,
  epoch: number,
  confirmedWrite: number | undefined
): boolean {
  const current = conflictEpochs.get(queryClient);
  return (
    !current ||
    epoch === current.epoch ||
    (epoch >= current.refreshEpoch &&
      confirmedWrite !== undefined &&
      confirmedWrite > current.rejectedWrite)
  );
}

/**
 * A rejected compare-and-swap never replays its old subtree. Refresh before
 * the surface offers another edit so its updater runs against current state.
 * Keep the original mutation error visible even if this refresh also fails.
 * @example await refreshAppSettingsAfterConflict(queryClient, error);
 */
export async function refreshAppSettingsAfterConflict(
  queryClient: QueryClient,
  error: unknown
): Promise<void> {
  if (!isAppSettingsConflict(error)) return;
  recordAppSettingsConflict(queryClient);
  // Keep a failed or still-pending refresh visible to every writer. Cached
  // preferences from before the conflict are not a valid retry baseline.
  await queryClient.invalidateQueries({
    queryKey: appSettingsKeys.current(),
    refetchType: 'none',
  });
  // Default cancellation restores the state from before the canceled read,
  // which can clear the conflict invalidation while the new read is pending.
  await queryClient.cancelQueries({ queryKey: appSettingsKeys.current() }, { revert: false });
  await queryClient.fetchQuery({ ...appSettingsQueryOptions(), staleTime: 0 }).catch(() => {
    void queryClient.invalidateQueries({
      queryKey: appSettingsKeys.current(),
      refetchType: 'none',
    });
  });
}

/**
 * The app-settings endpoint rejected an outdated repository snapshot.
 * @example const rejectedSnapshot = isAppSettingsConflict(error);
 */
export function isAppSettingsConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'CONFLICT';
}

/**
 * Re-read a rejected baseline before an updater constructs its next patch.
 * @example const settings = await appSettingsForWrite(queryClient);
 */
export async function appSettingsForWrite(queryClient: QueryClient): Promise<AppSettingsCache> {
  const cached = queryClient.getQueryData<AppSettingsCache>(appSettingsKeys.current());
  if (
    cached !== undefined &&
    !queryClient.getQueryState(appSettingsKeys.current())?.isInvalidated
  ) {
    return cached;
  }
  return queryClient.fetchQuery({ ...appSettingsQueryOptions(), staleTime: 0 });
}
