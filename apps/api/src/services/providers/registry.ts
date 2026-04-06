/**
 * In-memory provider registry.
 * Providers register themselves at startup; routes resolve them by type or model.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import { getDb } from '../../db/database';
import type { AIProvider } from './types';
import { parseStringArray } from '../../utils/json';

const registry = new Map<ProviderType, AIProvider>();

/**
 * Registers an AI provider. Calling this again with the same type replaces
 * the existing registration (useful in tests).
 */
export function registerProvider(provider: AIProvider): void {
  registry.set(provider.providerType, provider);
}

/**
 * Returns the registered provider for the given type.
 * Throws if the provider has not been registered.
 */
export function getProvider(type: ProviderType): AIProvider {
  const provider = registry.get(type);
  if (!provider) {
    throw new Error(`AI provider '${type}' is not registered.`);
  }
  return provider;
}

/**
 * Returns the list of all currently registered provider types.
 */
export function listRegisteredProviderTypes(): ProviderType[] {
  return Array.from(registry.keys());
}

/**
 * Clears the cached model listing for a single provider.
 */
export function invalidateProviderModelCache(type: ProviderType, userId?: string): void {
  registry.get(type)?.invalidateModelCache?.(userId);
}

/**
 * Removes all registered providers. Intended for test isolation only.
 */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * Resolves the provider responsible for a given model by looking up the
 * connector that has the model enabled in secret_metadata.
 * Falls back to 'gemini' when no connector row is found.
 */
export async function getProviderForModel(modelName: string, userId: string): Promise<AIProvider> {
  const db = getDb();
  const rows = await db
    .selectFrom('secret_metadata')
    .select(['provider', 'enabledModels'])
    .where((eb) => eb.or([eb('userId', '=', userId), eb('userId', 'is', null)]))
    .execute();

  for (const row of rows) {
    try {
      const enabled = parseStringArray(row.enabledModels);
      if (enabled.includes(modelName)) {
        return getProvider(row.provider as ProviderType);
      }
    } catch {
      console.warn(`[registry] Skipping connector '${row.provider}': malformed enabledModels JSON`);
    }
  }

  throw new Error(
    `[registry] No connector found for model "${modelName}". Configure a connector that includes this model.`
  );
}
