import { SETTINGS_SCOPES, SETTINGS_TOPIC, type SettingsScope } from '@mangostudio/shared/realtime';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';

import { type RealtimeSignal } from '@/lib/realtime/realtime-client';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { isOwnWriterId } from '@/lib/realtime/writer-id';

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
 * Sections to refresh for a signal.
 *
 * App settings auto-save is optimistic: this tab already holds the value it
 * just wrote, and the server's echo of that write can land while the user is
 * still editing the same control. Refetching then would replace what they are
 * typing with what they typed a moment earlier. The writer id names the
 * originating tab, so the echo of this tab's own write drops the `app` section
 * and nothing else — another tab's write, a hub-originated event, or a frame
 * from a hub that sends no writer id all apply at once.
 *
 * Dropping only `app` keeps the other sections live: a `provider` event still
 * applies during an app settings edit.
 */
function sectionsToRefresh(signal: RealtimeSignal): readonly SettingsPageScope[] {
  if (signal.type === 'subscribed') {
    // The ack covers every section: events published while the socket was
    // down are not replayed, so there is nothing narrower to go on.
    return SETTINGS_SCOPES.filter(isSettingsPageScope);
  }

  // Only exact-topic matches reach this listener, so a real event's scopes are
  // already settings sections.
  const scopes = (signal.message.scopes as readonly SettingsScope[] | undefined) ?? SETTINGS_SCOPES;
  const writerId = 'writerId' in signal.message ? signal.message.writerId : undefined;
  const ownEcho = isOwnWriterId(writerId);
  return scopes.filter(isSettingsPageScope).filter((scope) => !(ownEcho && scope === 'app'));
}

async function invalidateScopes(
  queryClient: QueryClient,
  scopes: readonly SettingsPageScope[]
): Promise<void> {
  await Promise.all(
    scopes.map((scope) => queryClient.invalidateQueries({ queryKey: SECTION_QUERY_KEYS[scope] }))
  );
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

  useRealtimeInvalidation(SETTINGS_TOPIC, 'settings-sections', (signal) =>
    invalidateScopes(queryClient, sectionsToRefresh(signal))
  );
}
