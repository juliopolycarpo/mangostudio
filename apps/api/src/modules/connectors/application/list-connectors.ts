/**
 * Use case: list all connectors for a user across all providers.
 */

import type { ConnectorStatus } from '@mangostudio/shared';
import {
  getProvider,
  listRegisteredProviderTypes,
} from '../../../services/providers/core/provider-registry';
import { isVisibleConnector, toConnector } from '../domain/connector';
import { listAllSecretMetadata } from '../infrastructure/connector-repository';

export async function listConnectors(userId: string): Promise<ConnectorStatus> {
  await Promise.allSettled(
    listRegisteredProviderTypes().map(async (providerType) => {
      await getProvider(providerType).syncConfigFileConnectors?.(userId);
    })
  );

  const rows = await listAllSecretMetadata(userId);
  return { connectors: rows.filter(isVisibleConnector).map(toConnector) };
}
