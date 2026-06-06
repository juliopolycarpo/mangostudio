/**
 * Hook: connector list state and refresh.
 */

import type { ConnectorStatus } from '@mangostudio/shared';
import { en } from '@mangostudio/shared/i18n';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

const connectorKeys = {
  status: ['connector-status'] as const,
};

export const connectorQueryOptions = () =>
  queryOptions({
    queryKey: connectorKeys.status,
    queryFn: async () => {
      const { data, error } = await client.api.settings.connectors.get();
      if (error) {
        throw new Error(extractApiError(error.value, en.settings.connectors.failedToLoad));
      }
      return data as ConnectorStatus;
    },
  });

export function useConnectors() {
  const { data: connectorStatus, refetch } = useQuery(connectorQueryOptions());

  const reload = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { connectorStatus, connectors: connectorStatus?.connectors ?? [], reload };
}
