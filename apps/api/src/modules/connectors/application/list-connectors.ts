/**
 * Use case: list all connectors for a user across all providers.
 */

import type { Connector, ConnectorStatus } from '@mangostudio/shared';
import { getChatGptUsage } from '../../../services/providers/chatgpt/usage-fetch';
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
    // Best-effort quota snapshot: fresh from the store, refreshed when stale,
    // and null when the backend has never answered. Skipped for connectors
    // that need reauth — the backend would only reject the token.
    const usage = needsReauth ? null : await getChatGptUsage(bundle);
    return {
      ...connector,
      accountLabel: maskSecret(bundle.email ?? bundle.accountId) ?? connector.maskedSuffix,
      planType: usage?.planType ?? bundle.planType,
      needsReauth,
      usage,
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
