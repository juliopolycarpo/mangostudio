import { QueryClient } from '@tanstack/react-query';
import { registerCapabilityInvalidationSources } from '@/features/chat/hooks/capability-invalidation';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
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
