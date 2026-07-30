/**
 * Publishes settings invalidation events on the realtime bus.
 *
 * The `settings` topic is shared by three modules (app-settings,
 * provider-settings, tool-settings), each owning one section, so the mapping
 * lives beside the bus instead of inside any one of them.
 */
import { SETTINGS_TOPIC, type SettingsScope } from '@mangostudio/shared/realtime';
import { getRealtimeBus } from './realtime-bus';

/**
 * Fire-and-forget, and only after the owning write succeeded: the socket is an
 * optimization, so a missing subscriber or a failed fan-out must never affect
 * the response the caller is about to return.
 */
export function publishSettingsInvalidation(userId: string, scope: SettingsScope): void {
  // Routes resolve the id as `user?.id ?? ''`; an unauthenticated write has no
  // subscriber to reach anyway.
  if (userId.length === 0) return;

  getRealtimeBus().publish(userId, {
    type: 'invalidate',
    topic: SETTINGS_TOPIC,
    scopes: [scope],
  });
}
