import type { ModelCatalogResponse } from '@mangostudio/shared';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { client } from '../lib/api-client';
import { ApiError } from '../lib/utils';
import { EMPTY_MODEL_CATALOG } from '../utils/model-utils';

export const catalogKeys = {
  all: ['model-catalog'] as const,
};

export const catalogQueryOptions = () =>
  queryOptions({
    queryKey: catalogKeys.all,
    queryFn: async () => {
      const { data, error } = await client.api.settings.models.get();
      if (error) throw new ApiError(error.value);
      return data as ModelCatalogResponse;
    },
    staleTime: 1000 * 60 * 55, // 55 minutes
    gcTime: 1000 * 60 * 60 * 2, // 2 hours
  });

export function useModelCatalog() {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery(catalogQueryOptions());

  const refreshCatalog = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const setCatalog = useCallback(
    (newData: ModelCatalogResponse) => {
      queryClient.setQueryData(catalogKeys.all, newData);
    },
    [queryClient]
  );

  return {
    catalog: data || EMPTY_MODEL_CATALOG,
    isLoading,
    refreshCatalog,
    setCatalog,
  };
}
