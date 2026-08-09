import { ENVIRONMENTS_TOPIC } from '@mangostudio/shared/realtime';
import { notifyEnvironmentInvalidation } from './environment-invalidation-hooks';
import { getRealtimeBus } from './realtime-bus';

/** Publishes one user-scoped refresh signal after environment state changes. */
export function publishEnvironmentInvalidation(userId: string): void {
  if (userId.length === 0) return;
  notifyEnvironmentInvalidation(userId);
  getRealtimeBus().publish(userId, {
    type: 'invalidate',
    topic: ENVIRONMENTS_TOPIC,
  });
}
