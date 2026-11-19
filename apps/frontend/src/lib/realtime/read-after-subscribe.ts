import type { InvalidateQueryFilters, QueryClient } from '@tanstack/react-query';

import type { RealtimeSignal } from './realtime-client';

/**
 * Whether a read already reflects everything the new subscription would have
 * announced, so its ack has nothing left to refresh.
 *
 * That holds only for a read taken after the subscribe frame was sent: a write
 * after the frame reaches the tab as its own frame, while one between the read
 * and the hub processing the frame is in neither. Comparing against the ack's
 * arrival, or against a fixed window before it, would count such a read as
 * covered and hide that write. A read made before the frame is refetched.
 *
 * `requestedAt` is `undefined` when the sender cannot say when the frame went
 * out, which reads as "the data may predate the subscription".
 */
export function isReadAfterSubscribe(
  dataUpdatedAt: number | undefined,
  requestedAt: number | undefined
): boolean {
  return dataUpdatedAt !== undefined && requestedAt !== undefined && dataUpdatedAt >= requestedAt;
}

/**
 * Invalidates the queries a realtime signal makes stale.
 *
 * An `invalidate` frame names a write, so every matching query is stale. A
 * `subscribed` ack is only a barrier for what the topic missed before it took
 * hold, so a query whose data was read after the subscribe frame was sent is
 * left alone: on a page load that is the read the same mount started, and
 * refetching it doubled every realtime-backed request (issue #948).
 *
 * @example
 * useRealtimeInvalidation(ACTIVITY_TOPIC, 'activity-feed', (signal) =>
 *   invalidateForSignal(queryClient, signal, { queryKey: activityKeys.all })
 * );
 */
export function invalidateForSignal(
  queryClient: QueryClient,
  signal: RealtimeSignal,
  filters: InvalidateQueryFilters
): Promise<void> {
  if (signal.type !== 'subscribed') return queryClient.invalidateQueries(filters);
  return queryClient.invalidateQueries({
    ...filters,
    predicate: (query) =>
      !isReadAfterSubscribe(query.state.dataUpdatedAt, signal.requestedAt) &&
      (filters.predicate?.(query) ?? true),
  });
}
