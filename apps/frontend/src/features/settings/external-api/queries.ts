/**
 * API key list query keys and options.
 */

import type { ListApiKeysResponse } from '@mangostudio/shared/api-keys';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { listApiKeys } from './api';

export const apiKeysKeys = {
  all: ['api-keys'] as const,
  list: () => [...apiKeysKeys.all, 'list'] as const,
};

export function apiKeysListQueryOptions() {
  return queryOptions({
    queryKey: apiKeysKeys.list(),
    staleTime: 30_000,
    queryFn: async (): Promise<ListApiKeysResponse> => listApiKeys(),
  });
}

export function useApiKeys() {
  const { data, isLoading, error, refetch } = useQuery(apiKeysListQueryOptions());
  return { keys: data?.keys ?? [], isLoading, error, refetch };
}
