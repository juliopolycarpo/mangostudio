import { CHATS_TOPIC } from '@mangostudio/shared/realtime';

import { getRealtimeBus } from './realtime-bus';

/**
 * Announces that a chat this account can see changed: created, edited, or moved
 * in the list because `chats.updatedAt` advanced.
 *
 * Signal-only, like every other topic: the frame says "the list is stale", and
 * the tab refetches to learn how. It is not an activity-feed signal. A turn that
 * ends without a feed row (cancelled, errored, exhausted) still reorders the
 * list, and publishing that on the activity topic made every tab refetch a feed
 * that had no new row.
 */
export function publishChatListInvalidation(userId: string): void {
  if (userId.length === 0) return;
  getRealtimeBus().publish(userId, {
    type: 'invalidate',
    topic: CHATS_TOPIC,
  });
}
