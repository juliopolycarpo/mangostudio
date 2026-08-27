import { SETTINGS_SCOPES, SETTINGS_TOPIC, type SettingsScope } from '@mangostudio/shared/realtime';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useRef } from 'react';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  appSettingsLocalWriteWindowRemainingMs,
  hasRecentAppSettingsLocalWrite,
} from '../app/local-write-window';
import { appSettingsKeys } from '../app/queries';
import { providerSettingsKeys } from '../providers/queries';
import { toolSettingsKeys } from '../tools/queries';

/**
 * Scopes this layout owns. `tool-identity` rides the same topic but is read
 * across environments, library, and chat, so its own query subscribes wherever
 * it is mounted instead of depending on a settings page being open.
 */
type SettingsPageScope = Exclude<SettingsScope, 'tool-identity'>;

function isSettingsPageScope(scope: SettingsScope): scope is SettingsPageScope {
  return scope !== 'tool-identity';
}

/**
 * Section → cache family. Each section maps to the root of its query-key
 * family, so a write to one section never refetches the other two.
 */
const SECTION_QUERY_KEYS: Record<SettingsPageScope, readonly unknown[]> = {
  app: appSettingsKeys.all,
  provider: providerSettingsKeys.all,
  tool: toolSettingsKeys.all,
};

/**
 * App settings auto-save is debounced and optimistic, so its own echo lands
 * while the edit is often still in the user's hands. Dropping just that scope
 * keeps the other sections live: a `provider` event still applies during an app
 * settings edit.
 *
 * Dropping is never the last word: `scheduleDeferredAppRefresh` re-applies the
 * scope once the window closes, because this filter cannot tell a self-echo
 * from another tab's write.
 */
function applicableScopes(scopes: readonly SettingsScope[]): readonly SettingsPageScope[] {
  const pageScopes = scopes.filter(isSettingsPageScope);
  if (!hasRecentAppSettingsLocalWrite()) return pageScopes;
  return pageScopes.filter((scope) => scope !== 'app');
}

async function invalidateScopes(
  queryClient: QueryClient,
  scopes: readonly SettingsPageScope[]
): Promise<void> {
  await Promise.all(
    scopes.map((scope) => queryClient.invalidateQueries({ queryKey: SECTION_QUERY_KEYS[scope] }))
  );
}

type DeferredRefreshRef = RefObject<ReturnType<typeof setTimeout> | null>;

/**
 * Applies an `app` invalidation that the echo window dropped, once that window
 * has closed. Suppressing the echo is only safe if the suppression is a delay
 * rather than a discard: the event may have come from another tab, and nothing
 * republishes it (`refetchOnWindowFocus` is off, and the socket only replays on
 * reconnect). Waiting the window out is what makes the two cases equivalent —
 * a genuine remote change lands late, and this tab's own echo refetches a value
 * it already holds.
 *
 * Re-arms itself if a fresh edit reopened the window while it waited, so a
 * continuous typing burst refreshes once at the end rather than mid-keystroke.
 */
function scheduleDeferredAppRefresh(timerRef: DeferredRefreshRef, refreshApp: () => void): void {
  if (timerRef.current !== null) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    if (hasRecentAppSettingsLocalWrite()) {
      scheduleDeferredAppRefresh(timerRef, refreshApp);
      return;
    }
    refreshApp();
  }, appSettingsLocalWriteWindowRemainingMs());
}

function cancelDeferredAppRefresh(timerRef: DeferredRefreshRef): void {
  if (timerRef.current === null) return;
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

/**
 * Applies an invalidation, holding the `app` scope back while this tab is
 * mid-write and re-applying it once the window closes. Both a real event and a
 * subscription acknowledgement come through here: the ack must not skip the
 * wait either, because the refetch it triggers would replace the cache that
 * `saveSettings` reads to build its next value, and the following keystroke
 * would then carry the server's older object into the pending PUT — dropping
 * every edit made before the ack landed. Deferring keeps the refresh; it only
 * moves it past the burst.
 */
async function invalidateEventScopes(
  queryClient: QueryClient,
  timerRef: DeferredRefreshRef,
  scopes: readonly SettingsScope[]
): Promise<void> {
  const applicable = applicableScopes(scopes);

  if (scopes.includes('app')) {
    if (applicable.includes('app')) {
      // Applied now, so anything held back is already covered.
      cancelDeferredAppRefresh(timerRef);
    } else {
      scheduleDeferredAppRefresh(timerRef, () => {
        void invalidateScopes(queryClient, ['app']);
      });
    }
  }

  await invalidateScopes(queryClient, applicable);
}

/**
 * Keeps every settings section fresh while the settings layout is mounted:
 * writes from another tab, and writes made on a sibling section page, land
 * without waiting for a window focus.
 *
 * Mounted once at the layout rather than per page so the subscription survives
 * navigation between sections instead of churning a socket topic each time.
 * A subscription acknowledgement refreshes every section because events
 * published while the socket was down are not replayed; it is never dropped,
 * only delayed behind an open write window like any other `app` refresh.
 */
export function useSettingsRealtimeInvalidation(): void {
  const queryClient = useQueryClient();
  const deferredAppRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => cancelDeferredAppRefresh(deferredAppRefreshRef), []);

  useRealtimeInvalidation(SETTINGS_TOPIC, 'settings-sections', (signal) =>
    invalidateEventScopes(
      queryClient,
      deferredAppRefreshRef,
      // The ack covers every section: events published while the socket was
      // down are not replayed, so there is nothing narrower to go on. Only
      // exact-topic matches reach this listener, so a real event's scopes are
      // already settings sections.
      signal.type === 'subscribed'
        ? SETTINGS_SCOPES
        : ((signal.message.scopes as readonly SettingsScope[] | undefined) ?? SETTINGS_SCOPES)
    )
  );
}
