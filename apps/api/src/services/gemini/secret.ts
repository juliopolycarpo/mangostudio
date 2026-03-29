/**
 * Shared Gemini API key orchestration: validation, persistence, status, and caching.
 * Now supports multiple connectors and flexible storage backends.
 */

import type { AddConnectorBody, Connector, GeminiSecretStatus } from '@mangostudio/shared';
import type { SecretMetadataRow, SecretSource } from '@mangostudio/shared/types';
import {
  GEMINI_PROVIDER,
  listSecretMetadata,
  getSecretMetadataById,
  upsertSecretMetadata,
  deleteSecretMetadata,
  type SecretMetadataInput,
} from '../secret-store/metadata';
import { bunSecretStore, type SecretStore } from '../secret-store/store';
import { join, dirname } from 'path';
import { getMangoDir } from '../../lib/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { randomUUID } from 'crypto';
import { getConfig } from '../../lib/config';

const GEMINI_VALIDATION_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface GeminiSecretServiceDependencies {
  secretStore?: SecretStore;
  fetchImpl?: FetchLike;
  now?: () => number;
  listMetadata?: (provider: string, userId: string) => Promise<SecretMetadataRow[]>;
  getMetadataById?: (id: string, userId: string) => Promise<SecretMetadataRow | null>;
  upsertMetadata?: (input: SecretMetadataInput) => Promise<void>;
  deleteMetadata?: (id: string, userId: string) => Promise<boolean>;
  /** Override the TOML config file path (useful in tests to prevent real file reads). */
  tomlFilePath?: string;
}

/** Error thrown when no active Gemini API key can be resolved. */
export class GeminiApiKeyMissingError extends Error {
  constructor() {
    super('No Gemini API key is configured or enabled. Check your Connectors in Settings.');
    this.name = 'GeminiApiKeyMissingError';
  }
}

/** Error thrown when Gemini rejects a candidate API key. */
export class InvalidGeminiApiKeyError extends Error {
  constructor(
    message: string = 'Gemini rejected the API key. Verify that it is valid and enabled.'
  ) {
    super(message);
    this.name = 'InvalidGeminiApiKeyError';
  }
}

/** Error thrown when Gemini cannot be reached for validation. */
export class GeminiValidationUnavailableError extends Error {
  constructor(message: string = 'Unable to validate the Gemini API key right now. Try again.') {
    super(message);
    this.name = 'GeminiValidationUnavailableError';
  }
}

function maskSecret(apiKey: string | null | undefined): string | undefined {
  if (!apiKey) {
    return undefined;
  }
  return apiKey.slice(-4);
}

function getEnvFilePath(): string {
  return join(getMangoDir(), '.env');
}

function getTomlFilePath(): string {
  return getConfig().configFilePath;
}

/**
 * Creates the Gemini secret service with injectable dependencies for tests.
 */
export function createGeminiSecretService(dependencies: GeminiSecretServiceDependencies = {}) {
  const secretStore = dependencies.secretStore ?? bunSecretStore;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const listMetadata = dependencies.listMetadata ?? listSecretMetadata;
  const getMetadataById = dependencies.getMetadataById ?? getSecretMetadataById;
  const upsertMetadata = dependencies.upsertMetadata ?? upsertSecretMetadata;
  const deleteMetadata = dependencies.deleteMetadata ?? deleteSecretMetadata;
  const resolvedTomlFilePath = dependencies.tomlFilePath ?? getTomlFilePath();

  /**
   * Syncs connectors from config.toml into the metadata database.
   */
  const syncConfigFileConnectors = async (userId: string): Promise<void> => {
    try {
      const configPath = resolvedTomlFilePath;
      if (!existsSync(configPath)) return;

      const content = readFileSync(configPath, 'utf8');
      const parsed = parseToml(content) as any;
      const tomlKeys = parsed.gemini_api_keys || {};

      const currentMetadata = await listMetadata(GEMINI_PROVIDER, userId);
      const configConnectors = currentMetadata.filter((m) => m.source === 'config-file');

      // 1. Add missing connectors from TOML to DB
      for (const [name, key] of Object.entries(tomlKeys)) {
        if (typeof key !== 'string') continue;

        const exists = configConnectors.find((c) => c.name === name);
        if (!exists) {
          const id = randomUUID();
          await upsertMetadata({
            id,
            name,
            provider: GEMINI_PROVIDER,
            configured: true,
            source: 'config-file',
            maskedSuffix: maskSecret(key),
            updatedAt: now(),
            enabledModels: [], // Initially empty
            userId: null, // Config file keys are global
          });
        } else {
          // Update masked suffix if it changed in file
          const currentSuffix = maskSecret(key);
          if (exists.maskedSuffix !== currentSuffix) {
            await upsertMetadata({
              ...exists,
              source: 'config-file', // Ensure correct type
              configured: true,
              maskedSuffix: currentSuffix,
              updatedAt: now(),
              enabledModels: JSON.parse(exists.enabledModels),
              userId: null,
            });
          }
        }
      }

      // 2. Remove connectors from DB that are no longer in TOML
      for (const connector of configConnectors) {
        if (!tomlKeys[connector.name]) {
          await deleteMetadata(connector.id, userId);
        }
      }
    } catch (err) {
      console.warn('[config] Failed to sync config.toml:', err);
    }
  };

  /**
   * Reads a secret value based on connector metadata.
   */
  const resolveSecretValue = async (connector: SecretMetadataRow): Promise<string | null> => {
    switch (connector.source) {
      case 'bun-secrets':
        try {
          return await secretStore.getSecret({
            service: 'mangostudio',
            name: `gemini-api-key:${connector.id}`,
          });
        } catch {
          return null;
        }

      case 'environment': {
        const envVar = `GEMINI_API_KEY_${connector.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        return process.env[envVar] || process.env.GEMINI_API_KEY || null;
      }

      case 'config-file': {
        try {
          const configPath = resolvedTomlFilePath;
          if (existsSync(configPath)) {
            const content = readFileSync(configPath, 'utf8');
            const parsed = parseToml(content) as any;
            return parsed.gemini_api_keys?.[connector.name] || null;
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

  return {
    /**
     * Returns all connectors and their UI-safe status.
     */
    async getGeminiSecretStatus(userId: string): Promise<GeminiSecretStatus> {
      await syncConfigFileConnectors(userId);

      const metadataRows = await listMetadata(GEMINI_PROVIDER, userId);

      const connectors: Connector[] = metadataRows.map((row) => ({
        id: row.id,
        name: row.name,
        provider: 'gemini' as const,
        configured: Boolean(row.configured),
        source: row.source,
        maskedSuffix: row.maskedSuffix ?? null,
        updatedAt: row.updatedAt,
        lastValidatedAt: row.lastValidatedAt ?? null,
        lastValidationError: row.lastValidationError ?? null,
        enabledModels: JSON.parse(row.enabledModels),
        userId: row.userId,
        baseUrl: row.baseUrl ?? null,
      }));

      return { connectors };
    },

    /**
     * Resolves the first available API key that has the requested model enabled.
     */
    async getResolvedGeminiApiKey(userId: string, requestedModel?: string): Promise<string> {
      await syncConfigFileConnectors(userId);

      const metadataRows = await listMetadata(GEMINI_PROVIDER, userId);

      for (const row of metadataRows) {
        if (!row.configured) continue;

        const enabledModels: string[] = JSON.parse(row.enabledModels);
        if (requestedModel && !enabledModels.includes(requestedModel)) continue;

        const value = await resolveSecretValue(row);
        if (value) return value;
      }

      throw new GeminiApiKeyMissingError();
    },

    /**
     * Validates a candidate API key.
     */
    async validateGeminiApiKey(apiKey: string): Promise<void> {
      let response: Response;
      try {
        response = await fetchImpl(GEMINI_VALIDATION_URL, {
          method: 'GET',
          headers: { 'x-goog-api-key': apiKey },
        });
      } catch (error) {
        throw new GeminiValidationUnavailableError(
          error instanceof Error ? error.message : undefined
        );
      }

      if (response.ok) return;
      if ([400, 401, 403].includes(response.status)) throw new InvalidGeminiApiKeyError();
      throw new GeminiValidationUnavailableError();
    },

    /**
     * Adds a new connector with the specified storage source.
     */
    async addGeminiConnector(userId: string, body: AddConnectorBody): Promise<Connector> {
      const apiKey = body.apiKey.trim();
      if (!apiKey) throw new Error('API Key cannot be empty');

      await this.validateGeminiApiKey(apiKey);

      const id = randomUUID();
      const timestamp = now();

      // Persist the actual secret
      switch (body.source) {
        case 'bun-secrets':
          await secretStore.setSecret(
            { service: 'mangostudio', name: `gemini-api-key:${id}` },
            apiKey
          );
          break;

        case 'config-file': {
          const configPath = resolvedTomlFilePath;
          mkdirSync(dirname(configPath), { recursive: true });
          let config: any = {};
          if (existsSync(configPath)) {
            config = parseToml(readFileSync(configPath, 'utf8'));
          }
          config.gemini_api_keys = config.gemini_api_keys || {};
          config.gemini_api_keys[body.name] = apiKey;
          writeFileSync(configPath, stringifyToml(config));
          break;
        }

        case 'environment': {
          const envPath = getEnvFilePath();
          const envVar = `GEMINI_API_KEY_${body.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          const envEntry = `
${envVar}="${apiKey}"
`;
          const currentContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
          writeFileSync(envPath, currentContent + envEntry);
          process.env[envVar] = apiKey;
          break;
        }
      }

      // Save metadata
      const input: SecretMetadataInput = {
        id,
        name: body.name,
        provider: GEMINI_PROVIDER,
        configured: true,
        source: body.source,
        maskedSuffix: maskSecret(apiKey),
        updatedAt: timestamp,
        lastValidatedAt: timestamp,
        enabledModels: [], // Initially empty
        userId: ['bun-secrets'].includes(body.source) ? userId : null, // keep env config global
        baseUrl: body.baseUrl ?? null,
      };

      await upsertMetadata(input);

      const status = await this.getGeminiSecretStatus(userId);
      return status.connectors.find((c) => c.id === id)!;
    },

    /**
     * Updates the list of enabled models for a connector.
     */
    async updateConnectorModels(
      userId: string,
      id: string,
      enabledModels: string[]
    ): Promise<void> {
      const metadata = await getMetadataById(id, userId);
      if (!metadata) throw new Error('Connector not found');

      await upsertMetadata({
        id: metadata.id,
        name: metadata.name,
        provider: metadata.provider,
        configured: Boolean(metadata.configured),
        source: metadata.source as SecretSource,
        maskedSuffix: metadata.maskedSuffix ?? null,
        updatedAt: now(),
        lastValidatedAt: metadata.lastValidatedAt ?? null,
        lastValidationError: metadata.lastValidationError ?? null,
        enabledModels,
        userId: metadata.userId,
      });
    },

    /**
     * Deletes a connector and its stored secret.
     */
    async deleteGeminiConnector(userId: string, id: string): Promise<void> {
      const metadata = await getMetadataById(id, userId);
      if (!metadata) return;

      if (metadata.source === 'bun-secrets') {
        await secretStore.deleteSecret({ service: 'mangostudio', name: `gemini-api-key:${id}` });
      }

      if (metadata.source === 'config-file') {
        try {
          const configPath = resolvedTomlFilePath;
          if (existsSync(configPath)) {
            const config: any = parseToml(readFileSync(configPath, 'utf8'));
            if (config.gemini_api_keys) {
              delete config.gemini_api_keys[metadata.name];
              writeFileSync(configPath, stringifyToml(config));
            }
          }
        } catch (err) {
          console.error('[config] Failed to remove key from config.toml:', err);
        }
      }

      if (metadata.source === 'environment') {
        try {
          const envPath = getEnvFilePath();
          if (existsSync(envPath)) {
            const envVar = `GEMINI_API_KEY_${metadata.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
            const content = readFileSync(envPath, 'utf8');
            const lines = content.split('\n');
            const filteredLines = lines.filter((line) => !line.trim().startsWith(`${envVar}=`));
            writeFileSync(envPath, filteredLines.join('\n'));
            delete process.env[envVar];
          }
        } catch (err) {
          console.error('[env] Failed to remove key from .env:', err);
        }
      }

      await deleteMetadata(id, userId);
    },
  };
}

const geminiSecretService = createGeminiSecretService();

export const getGeminiSecretStatus =
  geminiSecretService.getGeminiSecretStatus.bind(geminiSecretService);
export const getResolvedGeminiApiKey =
  geminiSecretService.getResolvedGeminiApiKey.bind(geminiSecretService);
export const validateGeminiApiKey =
  geminiSecretService.validateGeminiApiKey.bind(geminiSecretService);
export const addGeminiConnector = geminiSecretService.addGeminiConnector.bind(geminiSecretService);
export const updateConnectorModels =
  geminiSecretService.updateConnectorModels.bind(geminiSecretService);
export const deleteGeminiConnector =
  geminiSecretService.deleteGeminiConnector.bind(geminiSecretService);
