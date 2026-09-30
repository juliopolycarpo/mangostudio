import type { ModelCatalogResponse } from '@mangostudio/shared';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { client } from '../lib/api-client';
import { ApiError } from '../lib/utils';
import { EMPTY_MODEL_CATALOG, LOADING_MODEL_CATALOG } from '../utils/model-utils';

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
    // A shell bootstrap query: once refused, it is asked again by the bootstrap
    // panel's retry, not by whichever component mounts next — that would retry
    // a rate-limited request on every mount. See `features/bootstrap`.
    retryOnMount: false,
    gcTime: 1000 * 60 * 60 * 2, // 2 hours
  });

/**
 * The model catalog, with a loading placeholder until the hub first answers.
 *
 * The authenticated shell starts this request without waiting for it, so a
 * reader can mount before it lands. `catalog` is then `LOADING_MODEL_CATALOG`
 * and `isResolved` is false; anything that would act on a model — a send, a
 * compaction — must wait for `isResolved`. A refused request with no data
 * falls back to the empty catalog; the shell's bootstrap panel owns that case.
 *
 * @example
 * const { catalog, isResolved } = useModelCatalog();
 * const canSend = isResolved && catalog.textModels.length > 0;
 */
export function useModelCatalog() {
  const queryClient = useQueryClient();

  const { data, isLoading, isPending, refetch } = useQuery(catalogQueryOptions());

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
    catalog: data ?? (isPending ? LOADING_MODEL_CATALOG : EMPTY_MODEL_CATALOG),
    /** Whether the hub has answered with a catalog at least once. */
    isResolved: data !== undefined,
    isLoading,
    refreshCatalog,
    setCatalog,
  };
}
