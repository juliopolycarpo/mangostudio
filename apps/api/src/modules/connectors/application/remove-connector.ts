/**
 * Use case: remove a connector and its stored secret.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { ProviderType } from '@mangostudio/shared/types';
import { invalidateUnifiedCatalog } from '../../../services/providers/catalog';
import { invalidateProviderModelCache } from '../../../services/providers/core/provider-registry';
import { isReadOnlySharedConnector } from '../domain/connector';
import {
  deleteSecretMetadata,
  getSecretMetadataById,
} from '../infrastructure/connector-repository';
import { removeSecret } from '../infrastructure/secret-persistence';

export class ConnectorNotFoundError extends Error {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly status = 404;
  constructor() {
    super('Connector not found.');
    this.name = 'ConnectorNotFoundError';
  }
}

export class ConnectorOwnershipError extends Error {
  readonly code = ERROR_CODES.OWNERSHIP;
  readonly status = 403;
  constructor() {
    super('Cannot delete a shared connector.');
    this.name = 'ConnectorOwnershipError';
  }
}

export async function removeConnector(userId: string, id: string): Promise<void> {
  const meta = await getSecretMetadataById(id, userId);
  if (!meta) throw new ConnectorNotFoundError();
  if (isReadOnlySharedConnector(meta)) throw new ConnectorOwnershipError();

  await removeSecret(meta.id, meta.name, meta.provider as ProviderType, meta.source);
  await deleteSecretMetadata(meta.id, userId);
  invalidateProviderModelCache(meta.provider as ProviderType, userId);
  invalidateUnifiedCatalog(userId);

  console.warn(`[connectors] DEL connector ${id}`);
}
