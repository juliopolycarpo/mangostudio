/**
 * Use case: add a new connector for any provider.
 */

import { randomUUID } from 'node:crypto';
import type { AddConnectorBody, Connector } from '@mangostudio/shared';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import { invalidateUnifiedCatalog } from '../../../services/providers/catalog';
import { invalidateProviderModelCache } from '../../../services/providers/core/provider-registry';
import { maskSecret } from '../../../utils/secrets';
import { toConnector } from '../domain/connector';
import {
  getSecretMetadataById,
  upsertSecretMetadata,
} from '../infrastructure/connector-repository';
import { validateProviderKey } from '../infrastructure/provider-validation';
import { persistSecret } from '../infrastructure/secret-persistence';

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
  const provider = body.provider ?? 'gemini';
  const apiKey = body.apiKey.trim();

  if (!apiKey) throw new ConnectorValidationError('API Key cannot be empty.');

  // Enforced here rather than only in the picker, because the picker is not the
  // only way in: the endpoint accepts a provider whether or not a form rendered
  // it. Editing and deleting an existing connector stay allowed — this closes
  // new setup, not the connectors people already have.
  if (isDeprecatedProvider(provider)) {
    throw new ConnectorValidationError(
      `MangoStudio no longer offers ${provider} as a provider. Existing connectors keep working; new ones are not accepted.`,
      ERROR_CODES.UNSUPPORTED,
      410
    );
  }

  // ChatGPT refresh tokens rotate on every refresh; the user-edited config-file
  // and environment backends cannot follow that rotation, so only the OS secret
  // store is a valid home for the token bundle.
  if (provider === 'chatgpt' && body.source !== 'bun-secrets') {
    throw new ConnectorValidationError(
      'ChatGPT connectors can only be stored in the OS secret store (bun-secrets).'
    );
  }

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

  await persistSecret(id, body.name, provider, body.source, apiKey);

  await upsertSecretMetadata({
    id,
    name: body.name,
    provider,
    configured: true,
    source: body.source,
    maskedSuffix: maskSecret(apiKey),
    updatedAt: timestamp,
    lastValidatedAt: timestamp,
    enabledModels: [],
    userId,
    baseUrl: provider === 'deepseek' ? body.baseUrl?.trim() || null : (body.baseUrl ?? null),
    organizationId: provider === 'openai' ? (body.organizationId ?? null) : null,
    projectId: provider === 'openai' ? (body.projectId ?? null) : null,
  });

  invalidateProviderModelCache(provider, userId);
  invalidateUnifiedCatalog(userId);

  const meta = await getSecretMetadataById(id, userId);
  if (!meta) throw new Error(`Connector ${id} not found after upsert`);
  return toConnector(meta);
}
