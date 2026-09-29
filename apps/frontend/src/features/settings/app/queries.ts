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

export function appSettingsQueryOptions() {
  return queryOptions({
    queryKey: appSettingsKeys.current(),
    staleTime: 30_000,
    // Either shape: a read answers with the pending flag, while a write's
    // answer lands here normalized and without one (see
    // `libraryLocationDefaultsPending`).
    queryFn: async (): Promise<AppSettings | AppSettingsResponse> => {
      const { data, error } = await client.api.settings.app.get();
      if (error) throw new ApiError(error.value);
      // The normalizer only knows stored preferences, so the flag describing
      // this answer is carried across it explicitly.
      return {
        ...normalizeAppSettings(data ?? DEFAULT_APP_SETTINGS),
        libraryLocationDefaultsPending: libraryLocationDefaultsPending(data ?? undefined),
      };
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
 * The app settings a library-location write may build its full location map
 * on. Never the pending placeholder: every location in that map travels as an
 * explicit value, so writing it would store the placeholder for good. Refetches
 * once when the cache is pending, and refuses if the hub is still detecting.
 *
 * @example
 * const locations = libraryLocationsFor(await appSettingsForLocationWrite(queryClient));
 */
export async function appSettingsForLocationWrite(queryClient: QueryClient): Promise<AppSettings> {
  const cached = queryClient.getQueryData<AppSettings | AppSettingsResponse>(
    appSettingsKeys.current()
  );
  if (cached !== undefined && !libraryLocationDefaultsPending(cached)) {
    return normalizeAppSettings(cached);
  }
  const fetched = await queryClient.fetchQuery({ ...appSettingsQueryOptions(), staleTime: 0 });
  if (!libraryLocationDefaultsPending(fetched)) return normalizeAppSettings(fetched);
  throw new Error(
    'expected app settings with detected library-location defaults | received: libraryLocationDefaultsPending: true (the hub is still detecting installed agent CLIs)'
  );
}
