/**
 * Use case: update the enabled-models list for a connector.
 */

import {
  getSecretMetadataById,
  upsertSecretMetadata,
} from '../infrastructure/connector-repository';
import { recalculateUnifiedCatalog } from '../../../services/providers/catalog';
import { ERROR_CODES } from '@mangostudio/shared/errors';

export class ConnectorNotFoundError extends Error {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly status = 404;
  constructor() {
    super('Connector not found.');
    this.name = 'ConnectorNotFoundError';
  }
}

export async function updateConnectorModels(
  userId: string,
  id: string,
  enabledModels: string[]
): Promise<void> {
  const meta = await getSecretMetadataById(id, userId);
  if (!meta) throw new ConnectorNotFoundError();

  await upsertSecretMetadata({
    id: meta.id,
    name: meta.name,
    provider: meta.provider,
    configured: Boolean(meta.configured),
    source: meta.source,
    maskedSuffix: meta.maskedSuffix ?? null,
    updatedAt: Date.now(),
    lastValidatedAt: meta.lastValidatedAt ?? null,
    lastValidationError: meta.lastValidationError ?? null,
    enabledModels,
    userId: meta.userId,
    baseUrl: meta.baseUrl ?? null,
    organizationId: meta.organizationId ?? null,
    projectId: meta.projectId ?? null,
  });

  recalculateUnifiedCatalog(userId);
}
