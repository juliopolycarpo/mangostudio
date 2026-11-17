import { QueryClient } from '@tanstack/react-query';

import { registerCapabilityInvalidationSources } from '@/features/chat/hooks/capability-invalidation';
import { queryRetryDelay, shouldRetryQuery } from '@/lib/environment-unavailable';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // One retry, except where the hub says an environment will not come back
      // by itself; a transient `ENVIRONMENT_UNAVAILABLE` waits for the hub's own
      // backoff instead of landing inside it. See `@/lib/environment-unavailable`.
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
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
