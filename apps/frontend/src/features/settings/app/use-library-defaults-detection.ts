/**
 * App settings for a surface that shows which library locations are enabled,
 * and whether that enablement is real yet.
 *
 * Right after a hub start the settings read answers before the hub has
 * detected which agent CLIs are installed, so every location the user never
 * set carries a placeholder. The hub publishes an `app` settings invalidation
 * once detection lands, but the settings layout's own subscription is not
 * mounted on the library screens — so while pending, this hook listens itself
 * and refetches on that event (or on the subscription ack, which covers an
 * event published before it subscribed).
 *
 * // Usage: const { settings, defaultsPending } = useLibraryDefaultsDetection();
 */

import type { AppSettings } from '@mangostudio/shared/app-settings';
import { SETTINGS_TOPIC, type SettingsScope } from '@mangostudio/shared/realtime';
import {
  type QueryClient,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { RealtimeSignal } from '@/lib/realtime/realtime-client';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { hasRecentAppSettingsLocalWrite } from './local-write-window';
import {
  appSettingsKeys,
  appSettingsQueryOptions,
  libraryLocationDefaultsPending,
} from './queries';

export interface LibraryDefaultsDetection {
  /** Undefined until the first answer arrives. */
  readonly settings: AppSettings | undefined;
  /** True while `settings` carries placeholder library-location defaults. */
  readonly defaultsPending: boolean;
  readonly query: UseQueryResult<AppSettings>;
}

/**
 * Reads app settings and, while their library-location defaults are pending,
 * keeps listening for the hub's `app` invalidation.
 *
 * @example
 * const { settings, defaultsPending } = useLibraryDefaultsDetection();
 * if (defaultsPending) return <p>{t.library.locationSettings.detecting}</p>;
 */
export function useLibraryDefaultsDetection(): LibraryDefaultsDetection {
  const queryClient = useQueryClient();
  const query = useQuery(appSettingsQueryOptions());
  const defaultsPending = libraryLocationDefaultsPending(query.data);

  useRealtimeInvalidation(
    defaultsPending ? SETTINGS_TOPIC : null,
    'library-location-defaults',
    (signal) => refetchOnAppInvalidation(queryClient, signal)
  );

  return { settings: query.data, defaultsPending, query };
}

/**
 * Refetches app settings for an `app` invalidation or a subscription ack.
 * Skipped while this tab is mid-write: that write's own answer waited for
 * detection, so it already carries the real defaults, and refetching now would
 * clobber the settings screen's optimistic edit.
 */
function refetchOnAppInvalidation(queryClient: QueryClient, signal: RealtimeSignal): Promise<void> {
  if (hasRecentAppSettingsLocalWrite()) return Promise.resolve();
  if (signal.type === 'subscribed' || isAppScope(signal.message.scopes)) {
    return queryClient.invalidateQueries({ queryKey: appSettingsKeys.all });
  }
  return Promise.resolve();
}

function isAppScope(scopes: unknown): boolean {
  // A settings event without scopes invalidates every section, `app` included.
  if (!Array.isArray(scopes)) return true;
  return (scopes as readonly SettingsScope[]).includes('app');
}
