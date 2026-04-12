/**
 * Use case: add a new connector for any provider.
 */

import { randomUUID } from 'crypto';
import type { Connector } from '@mangostudio/shared';
import type { AddConnectorBody } from '@mangostudio/shared';
import type { ProviderType, SecretSource } from '@mangostudio/shared/types';
import { maskSecret } from '../../../utils/secrets';
import { toConnector } from '../domain/connector';
import { persistSecret } from '../infrastructure/secret-persistence';
import { validateProviderKey } from '../infrastructure/provider-validation';
import {
  upsertSecretMetadata,
  getSecretMetadataById,
} from '../infrastructure/connector-repository';
import { invalidateUnifiedCatalog } from '../../../services/providers/catalog';
import { invalidateProviderModelCache } from '../../../services/providers/registry';
import { ERROR_CODES } from '@mangostudio/shared/errors';

export class ConnectorValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = ERROR_CODES.VALIDATION,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = 'ConnectorValidationError';
  }
}

export async function addConnector(userId: string, body: AddConnectorBody): Promise<Connector> {
  const provider = (body.provider ?? 'gemini') as ProviderType;
  const apiKey = body.apiKey.trim();

  if (!apiKey) throw new ConnectorValidationError('API Key cannot be empty.');

  if (provider === 'openai-compatible' && !body.baseUrl?.trim()) {
    throw new ConnectorValidationError(
      'baseUrl is required for openai-compatible connectors.',
      ERROR_CODES.VALIDATION,
      400
    );
  }

  await validateProviderKey(provider, apiKey, {
    baseUrl: body.baseUrl,
    organizationId: provider === 'openai' ? body.organizationId : undefined,
    projectId: provider === 'openai' ? body.projectId : undefined,
  });

  const id = randomUUID();
  const timestamp = Date.now();

  await persistSecret(id, body.name, provider, body.source as SecretSource, apiKey);

  await upsertSecretMetadata({
    id,
    name: body.name,
    provider,
    configured: true,
    source: body.source as SecretSource,
    maskedSuffix: maskSecret(apiKey),
    updatedAt: timestamp,
    lastValidatedAt: timestamp,
    enabledModels: [],
    userId,
    baseUrl: body.baseUrl ?? null,
    organizationId: provider === 'openai' ? (body.organizationId ?? null) : null,
    projectId: provider === 'openai' ? (body.projectId ?? null) : null,
  });

  invalidateProviderModelCache(provider, userId);
  invalidateUnifiedCatalog(userId);

  const meta = await getSecretMetadataById(id, userId);
  if (!meta) throw new Error(`Connector ${id} not found after upsert`);
  return toConnector(meta);
}
