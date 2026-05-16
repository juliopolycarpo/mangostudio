/**
 * Hook: connector list state and refresh.
 */

import type { ConnectorStatus } from '@mangostudio/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const connectorKeys = {
  status: ['connector-status'] as const,
};

export const connectorQueryOptions = () =>
  queryOptions({
    queryKey: connectorKeys.status,
    queryFn: async () => {
      const { data, error } = await client.api.settings.connectors.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load connectors'));
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
