/**
 * Model-aware connector row selection shared by providers whose connectors
 * carry an optional enabled-models allowlist.
 */

import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { parseStringArray } from '../../../utils/json';

/**
 * Returns the configured rows that may serve `modelName`: rows explicitly
 * enabling the model first, then rows without an allowlist as fallback.
 * Without a model filter, every configured row qualifies.
 */
export function selectConnectorRowsForModel(
  rows: SecretMetadataRow[],
  modelName?: string
): SecretMetadataRow[] {
  const configuredRows = rows.filter((row) => row.configured);
  if (!modelName) return configuredRows;

  const explicitMatches: SecretMetadataRow[] = [];
  const fallbackMatches: SecretMetadataRow[] = [];

  for (const row of configuredRows) {
    const enabled = parseStringArray(row.enabledModels);
    if (enabled.includes(modelName)) {
      explicitMatches.push(row);
    } else if (enabled.length === 0) {
      fallbackMatches.push(row);
    }
  }

  return [...explicitMatches, ...fallbackMatches];
}
