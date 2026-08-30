import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
import { getRealtimeBus } from './realtime-bus';

/**
 * Announces that this account's activity feed has a new row, or that some
 * other account-scoped timestamp the feed's listeners also care about moved.
 *
 * Signal-only, like every other topic: the frame says "something happened", and
 * the tab refetches to learn what. Feed rows are published from the activity
 * recorder, so a new kind cannot ship a row nobody is told about. Terminal-turn
 * seams that intentionally skip a feed row (cancelled, errored, exhausted —
 * see `recordTurnCompletedActivity`) call this directly instead, so the chat
 * list still notices the `updatedAt` change; a listener that refetches and
 * finds nothing new degrades to a no-op.
 */
export function publishActivityInvalidation(userId: string): void {
  if (userId.length === 0) return;
  getRealtimeBus().publish(userId, {
    type: 'invalidate',
    topic: ACTIVITY_TOPIC,
  });
}
