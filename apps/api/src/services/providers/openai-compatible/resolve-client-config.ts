import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { parseStringArray } from '../../../utils/json';

export interface CompatibleClientConfig {
  apiKey: string;
  baseUrl: string;
}

export type ResolveCompatibleSecretValue = (row: SecretMetadataRow) => Promise<string | null>;

/** Resolves the first configured connector that can serve the requested model. */
export async function resolveCompatibleClientConfig(
  rows: SecretMetadataRow[],
  resolveSecretValue: ResolveCompatibleSecretValue,
  modelName?: string
): Promise<CompatibleClientConfig> {
  for (const row of rows) {
    if (!isUsableConnector(row, modelName)) continue;

    const apiKey = await resolveSecretValue(row);
    if (apiKey && row.baseUrl) return { apiKey, baseUrl: row.baseUrl };
  }

  throw new Error(
    'No openai-compatible connector with a valid baseUrl is configured for this model.'
  );
}

function isUsableConnector(row: SecretMetadataRow, modelName?: string): boolean {
  if (!row.configured) return false;
  if (!row.baseUrl) return false;

  const enabled = parseStringArray(row.enabledModels);
  if (modelName && enabled.length > 0 && !enabled.includes(modelName)) return false;

  return true;
}
