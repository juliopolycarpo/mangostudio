import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
import { getRealtimeBus } from './realtime-bus';

/**
 * Announces that this account's activity feed has a new row.
 *
 * Signal-only, like every other topic: the frame says "something happened", and
 * the tab refetches `GET /activity` to learn what. Published from the activity
 * recorder rather than from each of the seven emission seams, so a new kind
 * cannot ship a row nobody is told about.
 */
export function publishActivityInvalidation(userId: string): void {
  if (userId.length === 0) return;
  getRealtimeBus().publish(userId, {
    type: 'invalidate',
    topic: ACTIVITY_TOPIC,
  });
}
