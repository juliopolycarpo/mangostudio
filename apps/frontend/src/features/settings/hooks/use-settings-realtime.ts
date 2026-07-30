import { SETTINGS_SCOPES, SETTINGS_TOPIC, type SettingsScope } from '@mangostudio/shared/realtime';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { hasRecentAppSettingsLocalWrite } from '../app/local-write-window';
import { appSettingsKeys } from '../app/queries';
import { providerSettingsKeys } from '../providers/queries';
import { toolSettingsKeys } from '../tools/queries';

/**
 * Section → cache family. Each section maps to the root of its query-key
 * family, so a write to one section never refetches the other two.
 */
const SECTION_QUERY_KEYS: Record<SettingsScope, readonly unknown[]> = {
  app: appSettingsKeys.all,
  provider: providerSettingsKeys.all,
  tool: toolSettingsKeys.all,
};

/**
 * App settings auto-save is debounced and optimistic, so its own echo lands
 * while the edit is often still in the user's hands. Dropping just that scope
 * keeps the other sections live: a `provider` event still applies during an app
 * settings edit, and the next `app` event applies once the window closes.
 *
 * Events only — a subscription acknowledgement bypasses this, since nothing
 * replays it.
 */
function applicableScopes(scopes: readonly SettingsScope[]): readonly SettingsScope[] {
  if (!hasRecentAppSettingsLocalWrite()) return scopes;
  return scopes.filter((scope) => scope !== 'app');
}

async function invalidateScopes(
  queryClient: QueryClient,
  scopes: readonly SettingsScope[]
): Promise<void> {
  await Promise.all(
    scopes.map((scope) => queryClient.invalidateQueries({ queryKey: SECTION_QUERY_KEYS[scope] }))
  );
}

async function invalidateEventScopes(
  queryClient: QueryClient,
  scopes: readonly SettingsScope[]
): Promise<void> {
  await invalidateScopes(queryClient, applicableScopes(scopes));
}

/**
 * Keeps every settings section fresh while the settings layout is mounted:
 * writes from another tab, and writes made on a sibling section page, land
 * without waiting for a window focus.
 *
 * Mounted once at the layout rather than per page so the subscription survives
 * navigation between sections instead of churning a socket topic each time.
 * A subscription acknowledgement refreshes every section because events
 * published while the socket was down are not replayed.
 */
export function useSettingsRealtimeInvalidation(): void {
  const queryClient = useQueryClient();

  useRealtimeInvalidation(SETTINGS_TOPIC, (signal) => {
    if (signal.type === 'subscribed') {
      // Not filtered through the echo window: the ack stands in for every event
      // lost while the socket was down and is never replayed, so skipping `app`
      // here would leave that section stale until a reload
      // (`refetchOnWindowFocus` is off). A refetch cannot lose an in-flight
      // edit — the pending save still carries it to the server.
      return invalidateScopes(queryClient, SETTINGS_SCOPES);
    }
    // Only exact-topic matches reach this listener, so the validated event's
    // scopes are already settings sections.
    return invalidateEventScopes(
      queryClient,
      (signal.message.scopes as readonly SettingsScope[] | undefined) ?? SETTINGS_SCOPES
    );
  });
}
