/**
 * Hook: connector list state and refresh.
 */

import { useState, useEffect, useCallback } from 'react';
import type { ConnectorStatus } from '@mangostudio/shared';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export function useConnectors() {
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus | null>(null);

  const reload = useCallback(async () => {
    try {
      const { data, error } = await client.api.settings.connectors.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load connectors'));
      setConnectorStatus(data as ConnectorStatus);
    } catch (error) {
      console.error('[connectors] Failed to load connector status', error);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { connectorStatus, connectors: connectorStatus?.connectors ?? [], reload };
}
