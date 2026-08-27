import { useCallback, useRef } from 'react';

/**
 * The one-shot signal a refresh button hands its query's `queryFn`.
 *
 * `useQuery`'s `refetch()` takes no argument the queryFn can read, so there is
 * no query-key-based way to say "this one call must bypass the server's
 * cache." A ref does: `trigger` flips it true immediately before `refetch()`,
 * the queryFn reads it through `read` at the moment it actually runs, and the
 * `finally` clears it again — so exactly the request the click caused carries
 * the bypass, not the next automatic refetch a stale window triggers.
 *
 * @example
 * const forceRefresh = useForceRefresh();
 * const query = useQuery(githubPrsQueryOptions(chatId, filter, forceRefresh.read));
 * <GithubRefreshButton onRefresh={() => void forceRefresh.trigger(query.refetch)} />
 */
export function useForceRefresh(): {
  readonly read: () => boolean;
  readonly trigger: (refetch: () => Promise<unknown>) => Promise<void>;
} {
  const forced = useRef(false);

  const read = useCallback(() => forced.current, []);

  const trigger = useCallback(async (refetch: () => Promise<unknown>) => {
    forced.current = true;
    try {
      await refetch();
    } finally {
      forced.current = false;
    }
  }, []);

  return { read, trigger };
}
