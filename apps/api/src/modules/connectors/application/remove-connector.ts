/**
 * Use case: remove a connector and its stored secret.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { invalidateUnifiedCatalog } from '../../../services/providers/catalog';
import { invalidateProviderModelCache } from '../../../services/providers/core/provider-registry';
import { isReadOnlySharedConnector } from '../domain/connector';
import { getChatGptTokenService } from '../infrastructure/chatgpt/token-service';
import {
  deleteSecretMetadata,
  getSecretMetadataById,
} from '../infrastructure/connector-repository';
import { removeSecret } from '../infrastructure/secret-persistence';
import { ConnectorNotFoundError, ConnectorOwnershipError } from './connector-errors';

const connectorLogger = createDiagnosticLogger('connectors');

export async function removeConnector(userId: string, id: string): Promise<void> {
  const meta = await getSecretMetadataById(id, userId);
  if (!meta) throw new ConnectorNotFoundError();
  if (isReadOnlySharedConnector(meta)) throw new ConnectorOwnershipError();

  if (meta.provider === 'chatgpt') {
    await getChatGptTokenService()
      .deleteBundle(meta.id)
      .catch(() => false);
  } else {
    await removeSecret(meta.id, meta.name, meta.provider as ProviderType, meta.source);
  }
  await deleteSecretMetadata(meta.id, userId);
  invalidateProviderModelCache(meta.provider as ProviderType, userId);
  invalidateUnifiedCatalog(userId);

  connectorLogger.info('connector_deleted', { id, provider: meta.provider, source: meta.source });
}
