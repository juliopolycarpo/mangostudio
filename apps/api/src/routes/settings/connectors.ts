/**
 * Generic connector CRUD routes for all providers.
 */

import { Elysia, t } from 'elysia';
import type { Connector, ConnectorStatus } from '@mangostudio/shared';
import type { ProviderType, SecretSource } from '@mangostudio/shared/types';
import {
  listAllSecretMetadata,
  getSecretMetadataById,
  upsertSecretMetadata,
  deleteSecretMetadata,
  type SecretMetadataInput,
} from '../../services/secret-store/metadata';
import { bunSecretStore } from '../../services/secret-store/store';
import {
  updateConnectorModels,
  InvalidGeminiApiKeyError,
  GeminiValidationUnavailableError,
} from '../../services/gemini';
import { SecretStorageUnavailableError } from '../../services/secret-store';
import { invalidateUnifiedCatalog } from '../../services/providers/catalog';
import { getProvider } from '../../services/providers/registry';
import { getConfig, getMangoDir } from '../../lib/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { validateBaseUrl, UnsafeBaseUrlError } from '../../services/providers/base-url-policy';
import { requireAuth } from '../../plugins/auth-middleware';

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

export function maskSecret(apiKey: string | null | undefined): string | undefined {
  if (!apiKey) return undefined;
  return `****...${apiKey.slice(-4)}`;
}

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
    enabledModels: JSON.parse(row.enabledModels),
    userId: row.userId,
    baseUrl: row.baseUrl ?? null,
  };
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
      let config: any = {};
      if (existsSync(configPath)) {
        config = parseToml(readFileSync(configPath, 'utf8'));
      }
      config[cfg.tomlSection] = config[cfg.tomlSection] || {};
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
          const config: any = parseToml(readFileSync(configPath, 'utf8'));
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

/** Validates an API key for the given provider, with optional baseUrl for openai-compatible. */
export async function validateProviderKey(
  provider: ProviderType,
  apiKey: string,
  baseUrl?: string
): Promise<void> {
  if (provider === 'openai') {
    const p = getProvider('openai');
    await p.validateApiKey(apiKey);
    return;
  }

  if (provider === 'openai-compatible' && baseUrl) {
    await validateBaseUrl(baseUrl);
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`API key validation failed for ${baseUrl} (HTTP ${response.status}).`);
    }
    return;
  }

  if (provider === 'openai-compatible' && !baseUrl) {
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
});

export const connectorRoutes = new Elysia()
  .use(requireAuth)

  /** Returns all connectors across all providers. */
  .get('/connectors', async ({ user }): Promise<ConnectorStatus> => {
    const rows = await listAllSecretMetadata(user?.id ?? '');
    return { connectors: rows.map(toConnector) };
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

        await validateProviderKey(provider, apiKey, body.baseUrl);

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
        };
        await upsertSecretMetadata(input);

        invalidateUnifiedCatalog(userId);

        // Reload and return the new connector
        const meta = await getSecretMetadataById(id, userId);
        return toConnector(meta!);
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

        if (meta.userId !== userId) {
          set.status = 403;
          return { error: 'Cannot delete a shared connector.' };
        }

        await removeSecret(
          meta.id,
          meta.name,
          meta.provider as ProviderType,
          meta.source as SecretSource
        );
        await deleteSecretMetadata(meta.id, userId);
        invalidateUnifiedCatalog(userId);

        console.log(`[settings] DEL connector ${params.id}`);
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
        if (meta.userId !== userId) {
          set.status = 403;
          return { error: 'Cannot update models on a shared connector.' };
        }
        await updateConnectorModels(userId, params.id, body.enabledModels);
        invalidateUnifiedCatalog(userId);
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
