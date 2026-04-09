/**
 * Generic connector CRUD routes for all providers.
 */

import { Elysia, t } from 'elysia';
import type { Connector, ConnectorStatus } from '@mangostudio/shared';
import type { ProviderType, SecretMetadataRow, SecretSource } from '@mangostudio/shared/types';
import {
  listAllSecretMetadata,
  getSecretMetadataById,
  upsertSecretMetadata,
  deleteSecretMetadata,
  type SecretMetadataInput,
} from '../../services/secret-store/metadata';
import { bunSecretStore } from '../../services/secret-store/store';
import { maskSecret } from '../../utils/secrets';
import { InvalidGeminiApiKeyError, GeminiValidationUnavailableError } from '../../services/gemini';
import { SecretStorageUnavailableError } from '../../services/secret-store';
import {
  invalidateUnifiedCatalog,
  recalculateUnifiedCatalog,
} from '../../services/providers/catalog';
import {
  getProvider,
  invalidateProviderModelCache,
  listRegisteredProviderTypes,
} from '../../services/providers/registry';
import {
  validateOpenAIAuthContext,
  OpenAIAuthError,
  OpenAIConfigError,
} from '../../services/providers/openai-provider';
import { getConfig, getMangoDir } from '../../lib/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { stringify as stringifyToml } from 'smol-toml';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { validateBaseUrl, UnsafeBaseUrlError } from '../../services/providers/base-url-policy';
import { requireAuth } from '../../plugins/auth-middleware';
import { readTomlStringSections } from '../../lib/toml';
import { parseStringArray } from '../../utils/json';

/** Per-provider configuration for secret storage paths. */
const PROVIDER_SECRET_CONFIG: Record<ProviderType, { tomlSection: string; envPrefix: string }> = {
  gemini: { tomlSection: 'gemini_api_keys', envPrefix: 'GEMINI_API_KEY' },
  openai: { tomlSection: 'openai_api_keys', envPrefix: 'OPENAI_API_KEY' },
  'openai-compatible': {
    tomlSection: 'openai_compatible_api_keys',
    envPrefix: 'OPENAI_API_KEY',
  },
  anthropic: { tomlSection: 'anthropic_api_keys', envPrefix: 'ANTHROPIC_API_KEY' },
};

export function handleSecretRouteError(
  error: unknown,
  set: { status?: number | string }
): { error: string } {
  if (error instanceof UnsafeBaseUrlError) {
    set.status = 422;
    return { error: error.message };
  }

  if (error instanceof InvalidGeminiApiKeyError) {
    set.status = 422;
    return { error: error.message };
  }

  if (error instanceof SecretStorageUnavailableError) {
    set.status = 503;
    return { error: 'OS secret storage is unavailable on this machine.' };
  }

  if (error instanceof GeminiValidationUnavailableError) {
    set.status = 502;
    return { error: error.message };
  }

  if (error instanceof OpenAIAuthError) {
    set.status = error.status;
    return { error: error.message };
  }

  if (error instanceof OpenAIConfigError) {
    set.status = 422;
    return { error: error.message };
  }

  console.error('[settings] Unexpected secret route error:', error);
  set.status = 500;
  return { error: error instanceof Error ? error.message : 'Unexpected secret settings error.' };
}

export function toConnector(row: {
  id: string;
  name: string;
  provider: string;
  configured: number | boolean;
  source: string;
  maskedSuffix: string | null;
  updatedAt: number;
  lastValidatedAt: number | null;
  lastValidationError: string | null;
  enabledModels: string;
  userId: string | null;
  baseUrl: string | null;
}): Connector {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as ProviderType,
    configured: Boolean(row.configured),
    source: row.source as SecretSource,
    maskedSuffix: row.maskedSuffix ?? null,
    updatedAt: row.updatedAt,
    lastValidatedAt: row.lastValidatedAt ?? null,
    lastValidationError: row.lastValidationError ?? null,
    enabledModels: parseStringArray(row.enabledModels),
    userId: row.userId,
    baseUrl: row.baseUrl ?? null,
  };
}

function isReadOnlySharedConnector(row: { userId: string | null; source: string }): boolean {
  return row.userId === null && row.source !== 'config-file' && row.source !== 'environment';
}

function isVisibleConnector(row: SecretMetadataRow): boolean {
  if (
    row.provider === 'openai-compatible' &&
    row.source === 'config-file' &&
    row.userId === null &&
    !row.baseUrl
  ) {
    return false;
  }

  return true;
}

async function updateConnectorEnabledModels(
  row: SecretMetadataRow,
  enabledModels: string[]
): Promise<void> {
  await upsertSecretMetadata({
    id: row.id,
    name: row.name,
    provider: row.provider,
    configured: Boolean(row.configured),
    source: row.source,
    maskedSuffix: row.maskedSuffix ?? null,
    updatedAt: Date.now(),
    lastValidatedAt: row.lastValidatedAt ?? null,
    lastValidationError: row.lastValidationError ?? null,
    enabledModels,
    userId: row.userId,
    baseUrl: row.baseUrl ?? null,
    organizationId: row.organizationId ?? null,
    projectId: row.projectId ?? null,
  });
}

/** Persists an API key in the storage backend selected by `source`. */
export async function persistSecret(
  id: string,
  name: string,
  provider: ProviderType,
  source: SecretSource,
  apiKey: string
): Promise<void> {
  const cfg = PROVIDER_SECRET_CONFIG[provider];

  switch (source) {
    case 'bun-secrets':
      await bunSecretStore.setSecret(
        { service: 'mangostudio', name: `${provider}-api-key:${id}` },
        apiKey
      );
      break;

    case 'config-file': {
      const configPath = getConfig().configFilePath;
      mkdirSync(dirname(configPath), { recursive: true });
      const config = readTomlStringSections(configPath);
      config[cfg.tomlSection] ??= {};
      config[cfg.tomlSection][name] = apiKey;
      writeFileSync(configPath, stringifyToml(config));
      break;
    }

    case 'environment': {
      const envPath = join(getMangoDir(), '.env');
      const envVar = `${cfg.envPrefix}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const currentContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
      writeFileSync(envPath, `${currentContent}\n${envVar}="${apiKey}"\n`);
      process.env[envVar] = apiKey;
      break;
    }
  }
}

/** Removes an API key from the storage backend. */
export async function removeSecret(
  id: string,
  name: string,
  provider: ProviderType,
  source: SecretSource
): Promise<void> {
  const cfg = PROVIDER_SECRET_CONFIG[provider];

  switch (source) {
    case 'bun-secrets':
      try {
        await bunSecretStore.deleteSecret({
          service: 'mangostudio',
          name: `${provider}-api-key:${id}`,
        });
      } catch {
        // Ignore — secret may already be gone
      }
      break;

    case 'config-file': {
      try {
        const configPath = getConfig().configFilePath;
        if (existsSync(configPath)) {
          const config = readTomlStringSections(configPath);
          if (config[cfg.tomlSection]) {
            delete config[cfg.tomlSection][name];
            writeFileSync(configPath, stringifyToml(config));
          }
        }
      } catch (err) {
        console.error(`[settings] Failed to remove key from config.toml:`, err);
      }
      break;
    }

    case 'environment': {
      try {
        const envPath = join(getMangoDir(), '.env');
        if (existsSync(envPath)) {
          const envVar = `${cfg.envPrefix}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          const content = readFileSync(envPath, 'utf8');
          const lines = content.split('\n').filter((l) => !l.trim().startsWith(`${envVar}=`));
          writeFileSync(envPath, lines.join('\n'));
          delete process.env[envVar];
        }
      } catch (err) {
        console.error(`[settings] Failed to remove key from .env:`, err);
      }
      break;
    }
  }
}

/** Validates an API key for the given provider, with optional fields for openai and openai-compatible. */
export async function validateProviderKey(
  provider: ProviderType,
  apiKey: string,
  options?: { baseUrl?: string; organizationId?: string; projectId?: string }
): Promise<void> {
  if (provider === 'openai') {
    await validateOpenAIAuthContext({
      apiKey,
      organizationId: options?.organizationId,
      projectId: options?.projectId,
    });
    return;
  }

  if (provider === 'openai-compatible' && options?.baseUrl) {
    await validateBaseUrl(options.baseUrl);
    const response = await fetch(`${options.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(
        `API key validation failed for ${options.baseUrl} (HTTP ${response.status}).`
      );
    }
    return;
  }

  if (provider === 'openai-compatible' && !options?.baseUrl) {
    throw new Error('baseUrl is required for openai-compatible connectors.');
  }

  const p = getProvider(provider);
  await p.validateApiKey(apiKey);
}

export const connectorBodySchema = t.Object({
  name: t.String(),
  apiKey: t.String(),
  source: t.Union([
    t.Literal('bun-secrets'),
    t.Literal('environment'),
    t.Literal('config-file'),
    t.Literal('none'),
  ]),
  provider: t.Optional(
    t.Union([
      t.Literal('gemini'),
      t.Literal('openai'),
      t.Literal('openai-compatible'),
      t.Literal('anthropic'),
    ])
  ),
  baseUrl: t.Optional(t.String()),
  /** Optional OpenAI Organization ID — only meaningful for provider === 'openai'. */
  organizationId: t.Optional(t.String()),
  /** Optional OpenAI Project ID — only meaningful for provider === 'openai'. */
  projectId: t.Optional(t.String()),
});

export const connectorRoutes = new Elysia()
  .use(requireAuth)

  /** Returns all connectors across all providers. */
  .get('/connectors', async ({ user }): Promise<ConnectorStatus> => {
    const userId = user?.id ?? '';

    await Promise.allSettled(
      listRegisteredProviderTypes().map(async (providerType) => {
        await getProvider(providerType).syncConfigFileConnectors?.(userId);
      })
    );

    const rows = await listAllSecretMetadata(userId);
    return { connectors: rows.filter(isVisibleConnector).map(toConnector) };
  })

  /** Adds a new connector for any provider. */
  .post(
    '/connectors',
    async ({ body, set, user }): Promise<Connector | { error: string }> => {
      try {
        const provider = (body.provider ?? 'gemini') as ProviderType;
        const apiKey = body.apiKey.trim();
        if (!apiKey) throw new Error('API Key cannot be empty.');

        if (provider === 'openai-compatible' && !body.baseUrl?.trim()) {
          set.status = 400;
          return { error: 'baseUrl is required for openai-compatible connectors.' };
        }

        await validateProviderKey(provider, apiKey, {
          baseUrl: body.baseUrl,
          organizationId: provider === 'openai' ? body.organizationId : undefined,
          projectId: provider === 'openai' ? body.projectId : undefined,
        });

        const id = randomUUID();
        const timestamp = Date.now();
        const userId = user?.id ?? '';

        await persistSecret(id, body.name, provider, body.source as SecretSource, apiKey);

        const input: SecretMetadataInput = {
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
        };
        await upsertSecretMetadata(input);

        invalidateProviderModelCache(provider, userId);
        invalidateUnifiedCatalog(userId);

        // Reload and return the new connector
        const meta = await getSecretMetadataById(id, userId);
        if (!meta) throw new Error(`Connector ${id} not found after upsert`);
        return toConnector(meta);
      } catch (error) {
        return handleSecretRouteError(error, set);
      }
    },
    { body: connectorBodySchema }
  )

  /** Deletes a connector (provider-agnostic). */
  .delete(
    '/connectors/:id',
    async ({ params, set, user }): Promise<{ success: true } | { error: string }> => {
      try {
        const userId = user?.id ?? '';
        const meta = await getSecretMetadataById(params.id, userId);
        if (!meta) {
          set.status = 404;
          return { error: 'Connector not found.' };
        }

        if (isReadOnlySharedConnector(meta)) {
          set.status = 403;
          return { error: 'Cannot delete a shared connector.' };
        }

        await removeSecret(meta.id, meta.name, meta.provider as ProviderType, meta.source);
        await deleteSecretMetadata(meta.id, userId);
        invalidateProviderModelCache(meta.provider as ProviderType, userId);
        invalidateUnifiedCatalog(userId);

        console.warn(`[settings] DEL connector ${params.id}`);
        return { success: true };
      } catch (error) {
        return handleSecretRouteError(error, set);
      }
    },
    { params: t.Object({ id: t.String() }) }
  )

  /** Updates enabled models for a connector (provider-agnostic). */
  .put(
    '/connectors/:id/models',
    async ({ params, body, set, user }): Promise<{ success: true } | { error: string }> => {
      try {
        const userId = user?.id ?? '';
        const meta = await getSecretMetadataById(params.id, userId);
        if (!meta) {
          set.status = 404;
          return { error: 'Connector not found.' };
        }
        await updateConnectorEnabledModels(meta, body.enabledModels);
        recalculateUnifiedCatalog(userId);
        return { success: true };
      } catch (error) {
        return handleSecretRouteError(error, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ enabledModels: t.Array(t.String()) }),
    }
  );
