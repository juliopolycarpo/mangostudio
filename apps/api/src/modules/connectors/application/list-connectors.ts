/**
 * Use case: list all connectors for a user across all providers.
 */

import type { Connector, ConnectorStatus } from '@mangostudio/shared';
import {
  getProvider,
  listRegisteredProviderTypes,
} from '../../../services/providers/core/provider-registry';
import { maskSecret } from '../../../utils/secrets';
import { isVisibleConnector, toConnector } from '../domain/connector';
import { CHATGPT_REAUTH_REQUIRED_CODE } from '../infrastructure/chatgpt/oauth-client';
import { getChatGptTokenService } from '../infrastructure/chatgpt/token-service';
import { listAllSecretMetadata } from '../infrastructure/connector-repository';

async function toConnectorStatus(row: Parameters<typeof toConnector>[0]): Promise<Connector> {
  const connector = toConnector(row);
  if (connector.provider !== 'chatgpt') return connector;

  const needsReauth = row.lastValidationError === CHATGPT_REAUTH_REQUIRED_CODE;
  try {
    const bundle = await getChatGptTokenService().readBundle(row.id);
    return {
      ...connector,
      accountLabel: maskSecret(bundle.email ?? bundle.accountId) ?? connector.maskedSuffix,
      planType: bundle.planType,
      needsReauth,
    };
  } catch {
    return {
      ...connector,
      accountLabel: connector.maskedSuffix,
      planType: null,
      needsReauth: true,
    };
  }
}

export async function listConnectors(userId: string): Promise<ConnectorStatus> {
  await Promise.allSettled(
    listRegisteredProviderTypes().map(async (providerType) => {
      await getProvider(providerType).syncConfigFileConnectors?.(userId);
    })
  );

  const rows = await listAllSecretMetadata(userId);
  return { connectors: await Promise.all(rows.filter(isVisibleConnector).map(toConnectorStatus)) };
}
