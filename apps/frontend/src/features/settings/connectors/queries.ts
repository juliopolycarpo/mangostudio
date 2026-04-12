/**
 * Connector query helpers.
 */

import type { ConnectorStatus } from '@mangostudio/shared';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const connectorKeys = {
  all: ['connectors'] as const,
  list: () => [...connectorKeys.all, 'list'] as const,
};

export async function fetchConnectors(): Promise<ConnectorStatus> {
  const { data, error } = await client.api.settings.connectors.get();
  if (error) throw new Error(extractApiError(error.value, 'Failed to load connectors'));
  return data as ConnectorStatus;
}
