import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';

import { getRealtimeBus } from './realtime-bus';

/**
 * Announces that this account's activity feed has a new row.
 *
 * Signal-only, like every other topic: the frame says "something happened", and
 * the tab refetches to learn what. Feed rows are published from the activity
 * recorder, so a new kind cannot ship a row nobody is told about. A chat that
 * moved without a feed row is not this topic's business; see
 * `publishChatListInvalidation`.
 */
export function publishActivityInvalidation(userId: string): void {
  if (userId.length === 0) return;
  getRealtimeBus().publish(userId, {
    type: 'invalidate',
    topic: ACTIVITY_TOPIC,
  });
}
