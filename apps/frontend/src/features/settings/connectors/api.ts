/**
 * Connector API mutation functions.
 */

import type { Connector } from '@mangostudio/shared';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function addConnector(
  body: Parameters<typeof client.api.settings.connectors.post>[0]
): Promise<Connector> {
  const { data, error } = await client.api.settings.connectors.post(body);
  if (error) throw new Error(extractApiError(error.value, 'Failed to add connector'));
  return data as Connector;
}

export async function deleteConnector(id: string): Promise<void> {
  const { error } = await client.api.settings.connectors({ id }).delete();
  if (error) throw new Error(extractApiError(error.value, 'Failed to delete connector'));
}

export async function updateConnectorModels(id: string, enabledModels: string[]): Promise<void> {
  const { error } = await client.api.settings.connectors({ id }).models.put({ enabledModels });
  if (error) throw new Error(extractApiError(error.value, 'Failed to update models'));
}
