/**
 * Connector domain types, constants, and pure domain helpers.
 */

import type { Connector } from '@mangostudio/shared';
import type { ProviderType, SecretMetadataRow, SecretSource } from '@mangostudio/shared/types';
import { parseStringArray } from '../../../utils/json';

/** Per-provider configuration for secret storage paths. */
export const PROVIDER_SECRET_CONFIG: Record<
  ProviderType,
  { tomlSection: string; envPrefix: string }
> = {
  gemini: { tomlSection: 'gemini_api_keys', envPrefix: 'GEMINI_API_KEY' },
  openai: { tomlSection: 'openai_api_keys', envPrefix: 'OPENAI_API_KEY' },
  'openai-compatible': {
    tomlSection: 'openai_compatible_api_keys',
    envPrefix: 'OPENAI_API_KEY',
  },
  anthropic: { tomlSection: 'anthropic_api_keys', envPrefix: 'ANTHROPIC_API_KEY' },
};

/** Maps a raw DB row to the shared Connector shape. */
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

/** Returns true for connectors that are globally shared and cannot be deleted by a user. */
export function isReadOnlySharedConnector(row: { userId: string | null; source: string }): boolean {
  return row.userId === null && row.source !== 'config-file' && row.source !== 'environment';
}

/**
 * Returns false for connectors that should be hidden from the UI.
 * Currently hides openai-compatible config-file connectors without a baseUrl,
 * as they are incomplete bootstrap placeholders.
 */
export function isVisibleConnector(row: SecretMetadataRow): boolean {
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
