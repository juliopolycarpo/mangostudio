import { QueryClient } from '@tanstack/react-query';
import { registerCapabilityInvalidationSources } from '@/features/chat/hooks/capability-invalidation';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      staleTime: 1000 * 30,
    },
  },
});

registerCapabilityInvalidationSources(queryClient);
