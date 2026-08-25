/**
 * The "what changed" feed, scoped by whatever the caller passes — since a
 * timestamp, one workdir, a page size.
 *
 * No `refetchInterval`: the realtime `activity` signal plus the window's own
 * focus refetch are what keep this warm, exactly like the external-agents
 * query it is modeled on. A poll here would be a second clock next to the
 * socket that already tells the feed something happened.
 */

import type { ListActivityQuery } from '@mangostudio/shared/activity';
import { queryOptions } from '@tanstack/react-query';
import { listActivity } from '@/services/activity-service';

export const activityKeys = {
  all: ['activity'] as const,
  list: (query: ListActivityQuery) => ['activity', 'list', query] as const,
};

export function activityQueryOptions(query: ListActivityQuery = {}) {
  return queryOptions({
    queryKey: activityKeys.list(query),
    queryFn: () => listActivity(query),
    staleTime: 30_000,
  });
}
