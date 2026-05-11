/**
 * In-memory provider registry.
 * Providers register themselves at startup; routes resolve them by type or model.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import { getDb } from '../../../db/database';
import type { AIProvider } from '../types';
import { parseStringArray } from '../../../utils/json';
import { recordProviderCacheHit, recordProviderCacheMiss } from './provider-observability';

const registry = new Map<ProviderType, AIProvider>();
const PROVIDER_ROUTE_CACHE_TTL_MS = 60_000;
const MAX_PROVIDER_ROUTE_CACHE_ENTRIES = 1_000;

interface CachedProviderRoute {
  readonly providerType: ProviderType;
  readonly expiresAt: number;
}

const providerRouteCache = new Map<string, CachedProviderRoute>();
let getProviderRegistryDb = getDb;

function createProviderRouteCacheKey(userId: string, modelName: string): string {
  return `${userId}\u0000${modelName}`;
}

function evictOldestCachedRoute(): void {
  if (providerRouteCache.size < MAX_PROVIDER_ROUTE_CACHE_ENTRIES) {
    return;
  }

  const oldestKey = providerRouteCache.keys().next().value;
  if (oldestKey !== undefined) {
    providerRouteCache.delete(oldestKey);
  }
}

function getCachedProviderRoute(userId: string, modelName: string): ProviderType | undefined {
  const cacheKey = createProviderRouteCacheKey(userId, modelName);
  const cachedRoute = providerRouteCache.get(cacheKey);
  if (!cachedRoute) {
    return undefined;
  }

  if (cachedRoute.expiresAt <= Date.now()) {
    providerRouteCache.delete(cacheKey);
    return undefined;
  }

  return cachedRoute.providerType;
}

function setCachedProviderRoute(
  userId: string,
  modelName: string,
  providerType: ProviderType
): void {
  evictOldestCachedRoute();
  providerRouteCache.set(createProviderRouteCacheKey(userId, modelName), {
    providerType,
    expiresAt: Date.now() + PROVIDER_ROUTE_CACHE_TTL_MS,
  });
}

export function invalidateProviderRoutingCache(userId?: string): void {
  if (!userId) {
    providerRouteCache.clear();
    return;
  }

  for (const cacheKey of providerRouteCache.keys()) {
    if (cacheKey.startsWith(`${userId}\u0000`)) {
      providerRouteCache.delete(cacheKey);
    }
  }
}

/**
 * Overrides the DB accessor used by model routing. Intended for test isolation only.
 */
export function setProviderRegistryDbForTests(dbAccessor?: typeof getDb): void {
  getProviderRegistryDb = dbAccessor ?? getDb;
}

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
  invalidateProviderRoutingCache(userId);
}

/**
 * Removes all registered providers. Intended for test isolation only.
 */
export function clearRegistry(): void {
  registry.clear();
  providerRouteCache.clear();
}

/**
 * Resolves the provider responsible for a given model by looking up the
 * connector that has the model enabled in secret_metadata.
 */
export async function getProviderForModel(modelName: string, userId: string): Promise<AIProvider> {
  const cachedProviderType = getCachedProviderRoute(userId, modelName);
  if (cachedProviderType) {
    recordProviderCacheHit(cachedProviderType, 'provider-route');
    return getProvider(cachedProviderType);
  }

  const db = getProviderRegistryDb();
  const rows = await db
    .selectFrom('secret_metadata')
    .select(['provider', 'enabledModels'])
    .where((eb) => eb.or([eb('userId', '=', userId), eb('userId', 'is', null)]))
    .execute();

  for (const row of rows) {
    try {
      const enabled = parseStringArray(row.enabledModels);
      if (enabled.includes(modelName)) {
        const providerType = row.provider as ProviderType;
        recordProviderCacheMiss(providerType, 'provider-route');
        setCachedProviderRoute(userId, modelName, providerType);
        return getProvider(providerType);
      }
    } catch {
      console.warn(`[registry] Skipping connector '${row.provider}': malformed enabledModels JSON`);
    }
  }

  throw new Error(
    `[registry] No connector found for model "${modelName}". Configure a connector that includes this model.`
  );
}
