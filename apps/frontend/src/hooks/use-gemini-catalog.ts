import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GeminiModelCatalogResponse } from '@mangostudio/shared';
import { EMPTY_GEMINI_MODEL_CATALOG } from '../utils/gemini-models';
import { client } from '../lib/api-client';

export const catalogKeys = {
  all: ['gemini-catalog'] as const,
};

export function useGeminiCatalog() {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: catalogKeys.all,
    queryFn: async () => {
      const { data, error } = await client.api.settings.models.gemini.get();
      if (error) throw new Error(error.value as unknown as string);
      return data as GeminiModelCatalogResponse;
    },
    staleTime: 1000 * 60 * 55, // 55 minutes
    gcTime: 1000 * 60 * 60 * 2, // 2 hours
  });

  const refreshCatalog = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const setCatalog = useCallback(
    (newData: GeminiModelCatalogResponse) => {
      queryClient.setQueryData(catalogKeys.all, newData);
    },
    [queryClient]
  );

  return {
    catalog: data || EMPTY_GEMINI_MODEL_CATALOG,
    isLoading,
    error: error ? error.message : null,
    refreshCatalog,
    setCatalog,
  };
}
