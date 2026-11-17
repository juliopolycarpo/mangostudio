import { ERROR_CODES } from '@mangostudio/shared/errors';
import { QueryClient } from '@tanstack/react-query';

import { registerCapabilityInvalidationSources } from '@/features/chat/hooks/capability-invalidation';
import { ApiError } from '@/lib/utils';

/** One retry, as before, except for an environment the hub already knows is down. */
const DEFAULT_QUERY_RETRIES = 1;

/**
 * The client-wide query retry policy.
 *
 * An `ENVIRONMENT_UNAVAILABLE` answer is not retried: the hub's connection
 * manager keeps its own backoff and refuses attempts inside it, so an immediate
 * client retry would be refused again and only add a request. This matches the
 * environment-probing queries that already set `retry: false`; the user's
 * refresh, or the next realtime invalidation, is the retry.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.code === ERROR_CODES.ENVIRONMENT_UNAVAILABLE) {
    return false;
  }
  return failureCount < DEFAULT_QUERY_RETRIES;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      // Every polled query in the app (observability at 5s, runtime health at
      // 15s, ChatGPT usage at 60s) inherits this: an interval must not keep a
      // hidden tab requesting. This is TanStack Query's default; pinned here so
      // a library default change cannot silently start background polling.
      refetchIntervalInBackground: false,
      staleTime: 1000 * 30,
    },
  },
});

registerCapabilityInvalidationSources(queryClient);
