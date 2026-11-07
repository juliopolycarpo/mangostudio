import { useQuery } from '@tanstack/react-query';

import { getOperation } from '@/services/operation-service';

export function useFirstChatOperation(operationId?: string) {
  return useQuery({
    queryKey: ['product-operation', operationId],
    enabled: Boolean(operationId),
    queryFn: () => getOperation(operationId ?? ''),
    retry: false,
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      (query.state.data?.state === 'accepted' || query.state.data?.state === 'running')
        ? 1000
        : false,
  });
}
