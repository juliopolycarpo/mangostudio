/**
 * The selector's view of the activity feed.
 *
 * Wraps the query with the realtime invalidation the hub's other selectors
 * already publish through: the `activity` topic is signal-only (no scopes),
 * so any event anywhere invalidates the whole feed rather than one workdir's
 * slice of it — the same tradeoff `useExternalAgents` makes for discovery.
 */

import type { ListActivityQuery } from '@mangostudio/shared/activity';
import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { activityKeys, activityQueryOptions } from './queries';

export interface UseActivityOptions {
  readonly since?: number;
  readonly workdir?: string;
  readonly limit?: number;
}

export function useActivity(options?: UseActivityOptions) {
  const queryClient = useQueryClient();
  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: activityKeys.all });
  }, [queryClient]);

  useRealtimeInvalidation(ACTIVITY_TOPIC, invalidate);

  const since = options?.since;
  const workdir = options?.workdir;
  const limit = options?.limit;
  const query = useMemo<ListActivityQuery>(
    () => ({
      ...(since !== undefined ? { since } : {}),
      ...(workdir ? { workdir } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }),
    [since, workdir, limit]
  );

  const { data, isLoading, isError } = useQuery(activityQueryOptions(query));

  return useMemo(
    () => ({
      events: data?.events ?? [],
      nextCursor: data?.nextCursor,
      isLoading,
      isError,
    }),
    [data, isLoading, isError]
  );
}
