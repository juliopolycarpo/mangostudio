/**
 * Generic provider secret service factory.
 * Extracts the shared resolution/sync logic from the Gemini-specific implementation
 * so other providers can reuse it with minimal configuration.
 */

import type { ProviderType, SecretMetadataRow } from '@mangostudio/shared/types';
import {
  listSecretMetadata,
  getSecretMetadataById,
  upsertSecretMetadata,
  deleteSecretMetadata,
  type SecretMetadataInput,
} from '../secret-store/metadata';
import { bunSecretStore, type SecretStore } from '../secret-store/store';
import { getConfig } from '../../lib/config';
import { existsSync, readFileSync } from 'fs';
import { parse as parseToml } from 'smol-toml';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Configuration required to create a provider secret service instance. */
export interface ProviderSecretServiceConfig {
  /** The provider this service manages. */
  provider: ProviderType;
  /** TOML section name that holds named keys, e.g. 'gemini_api_keys'. */
  tomlSection: string;
  /** Environment variable prefix, e.g. 'GEMINI_API_KEY'. */
  envVarPrefix: string;
  /** Called to validate a candidate API key against the real provider. */
  validateFn: (apiKey: string, fetchImpl: FetchLike) => Promise<void>;
}

/** Injectable dependencies (primarily for testing). */
export interface ProviderSecretServiceDeps {
  secretStore?: SecretStore;
  fetchImpl?: FetchLike;
  now?: () => number;
  listMetadata?: (provider: string, userId: string) => Promise<SecretMetadataRow[]>;
  getMetadataById?: (id: string, userId: string) => Promise<SecretMetadataRow | null>;
  upsertMetadata?: (input: SecretMetadataInput) => Promise<void>;
  deleteMetadata?: (id: string, userId: string) => Promise<boolean>;
  tomlFilePath?: string;
}

/** Error thrown when no active key can be resolved for a provider. */
export class ProviderApiKeyMissingError extends Error {
  constructor(provider: ProviderType) {
    super(`No ${provider} API key is configured or enabled. Check your Connectors in Settings.`);
    this.name = 'ProviderApiKeyMissingError';
  }
}

function maskSecret(apiKey: string | null | undefined): string | undefined {
  if (!apiKey) return undefined;
  return apiKey.slice(-4);
}

/**
 * Creates a provider-agnostic secret service.
 * Shared logic: config-file sync, env-var resolution, key resolution by model.
 */
export function createProviderSecretService(
  config: ProviderSecretServiceConfig,
  deps: ProviderSecretServiceDeps = {}
) {
  const secretStore = deps.secretStore ?? bunSecretStore;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const listMeta = deps.listMetadata ?? listSecretMetadata;
  const getMetaById = deps.getMetadataById ?? getSecretMetadataById;
  const upsertMeta = deps.upsertMetadata ?? upsertSecretMetadata;
  const deleteMeta = deps.deleteMetadata ?? deleteSecretMetadata;
  const tomlFilePath = deps.tomlFilePath ?? getConfig().configFilePath;

  const resolveSecretValue = async (connector: SecretMetadataRow): Promise<string | null> => {
    switch (connector.source) {
      case 'bun-secrets':
        try {
          return await secretStore.getSecret({
            service: 'mangostudio',
            name: `${config.provider}-api-key:${connector.id}`,
          });
        } catch {
          return null;
        }

      case 'environment': {
        const envVar = `${config.envVarPrefix}_${connector.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        return process.env[envVar] || process.env[config.envVarPrefix] || null;
      }

      case 'config-file': {
        try {
          if (existsSync(tomlFilePath)) {
            const parsed = parseToml(readFileSync(tomlFilePath, 'utf8')) as any;
            return parsed[config.tomlSection]?.[connector.name] || null;
          }
        } catch {
          return null;
        }
        return null;
      }

      default:
        return null;
    }
  };

  const syncConfigFileConnectors = async (userId: string): Promise<void> => {
    try {
      if (!existsSync(tomlFilePath)) return;
      const parsed = parseToml(readFileSync(tomlFilePath, 'utf8')) as any;
      const tomlKeys = parsed[config.tomlSection] || {};
      const currentMeta = await listMeta(config.provider, userId);
      const configConnectors = currentMeta.filter((m) => m.source === 'config-file');

      for (const [name, key] of Object.entries(tomlKeys)) {
        if (typeof key !== 'string') continue;
        const exists = configConnectors.find((c) => c.name === name);
        if (!exists) {
          const { randomUUID } = await import('crypto');
          await upsertMeta({
            id: randomUUID(),
            name,
            provider: config.provider,
            configured: true,
            source: 'config-file',
            maskedSuffix: maskSecret(key),
            updatedAt: now(),
            enabledModels: [],
            userId: null,
          });
        } else {
          const currentSuffix = maskSecret(key);
          if (exists.maskedSuffix !== currentSuffix) {
            await upsertMeta({
              ...exists,
              source: 'config-file',
              configured: true,
              maskedSuffix: currentSuffix,
              updatedAt: now(),
              enabledModels: JSON.parse(exists.enabledModels),
              userId: null,
            });
          }
        }
      }

      for (const connector of configConnectors) {
        if (!tomlKeys[connector.name]) {
          await deleteMeta(connector.id, userId);
        }
      }
    } catch (err) {
      console.warn(`[${config.provider}] Failed to sync config.toml:`, err);
    }
  };

  return {
    async resolveApiKey(userId: string, requestedModel?: string): Promise<string> {
      await syncConfigFileConnectors(userId);
      const rows = await listMeta(config.provider, userId);

      for (const row of rows) {
        if (!row.configured) continue;
        const enabled: string[] = JSON.parse(row.enabledModels);
        if (requestedModel && !enabled.includes(requestedModel)) continue;
        const value = await resolveSecretValue(row);
        if (value) return value;
      }

      throw new ProviderApiKeyMissingError(config.provider);
    },

    async validateApiKey(apiKey: string): Promise<void> {
      await config.validateFn(apiKey, fetchImpl);
    },

    async syncConfigFileConnectors(userId: string): Promise<void> {
      return syncConfigFileConnectors(userId);
    },

    listMeta,
    getMetaById,
    upsertMeta,
    deleteMeta,
    now,
    secretStore,
    provider: config.provider,
    tomlFilePath,
    tomlSection: config.tomlSection,
    envVarPrefix: config.envVarPrefix,
    resolveSecretValue,
    maskSecret,
  };
}
