/**
 * In-memory provider registry.
 * Providers register themselves at startup; routes resolve them by type or model.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import { getDb } from '../../../db/database';
import { createDiagnosticLogger } from '../../../lib/logger';
import { parseStringArray } from '../../../utils/json';
import type { AIProvider } from '../types';
import { recordProviderCacheHit, recordProviderCacheMiss } from './provider-observability';

const PROVIDER_ROUTE_CACHE_TTL_MS = 60_000;
const MAX_PROVIDER_ROUTE_CACHE_ENTRIES = 1_000;
const registryLogger = createDiagnosticLogger('provider-registry');

interface CachedProviderRoute {
  readonly providerType: ProviderType;
  readonly expiresAt: number;
}

interface ProviderRegistry {
  invalidateProviderRoutingCache(userId?: string): void;
  setProviderRegistryDbForTests(nextDbAccessor?: typeof getDb): void;
  registerProvider(provider: AIProvider): void;
  getProvider(type: ProviderType): AIProvider;
  listRegisteredProviderTypes(): ProviderType[];
  invalidateProviderModelCache(type: ProviderType, userId?: string): void;
  clearRegistry(): void;
  getProviderForModel(modelName: string, userId: string): Promise<AIProvider>;
}

function createProviderRouteCacheKey(userId: string, modelName: string): string {
  return `${userId}\u0000${modelName}`;
}

function evictOldestCachedRoute(providerRouteCache: Map<string, CachedProviderRoute>): void {
  if (providerRouteCache.size < MAX_PROVIDER_ROUTE_CACHE_ENTRIES) {
    return;
  }

  const oldestKey = providerRouteCache.keys().next().value;
  if (oldestKey !== undefined) {
    providerRouteCache.delete(oldestKey);
  }
}

function getCachedProviderRoute(
  providerRouteCache: Map<string, CachedProviderRoute>,
  userId: string,
  modelName: string
): ProviderType | undefined {
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
  providerRouteCache: Map<string, CachedProviderRoute>,
  userId: string,
  modelName: string,
  providerType: ProviderType
): void {
  evictOldestCachedRoute(providerRouteCache);
  providerRouteCache.set(createProviderRouteCacheKey(userId, modelName), {
    providerType,
    expiresAt: Date.now() + PROVIDER_ROUTE_CACHE_TTL_MS,
  });
}

function createProviderRegistry(dbAccessor: typeof getDb = getDb): ProviderRegistry {
  const registry = new Map<ProviderType, AIProvider>();
  const providerRouteCache = new Map<string, CachedProviderRoute>();
  let getProviderRegistryDb = dbAccessor;

  return {
    invalidateProviderRoutingCache(userId?: string): void {
      if (!userId) {
        providerRouteCache.clear();
        return;
      }

      for (const cacheKey of providerRouteCache.keys()) {
        if (cacheKey.startsWith(`${userId}\u0000`)) {
          providerRouteCache.delete(cacheKey);
        }
      }
    },

    setProviderRegistryDbForTests(nextDbAccessor?: typeof getDb): void {
      getProviderRegistryDb = nextDbAccessor ?? getDb;
    },

    registerProvider(provider: AIProvider): void {
      registry.set(provider.providerType, provider);
    },

    getProvider(type: ProviderType): AIProvider {
      const provider = registry.get(type);
      if (!provider) {
        throw new Error(`AI provider '${type}' is not registered.`);
      }
      return provider;
    },

    listRegisteredProviderTypes(): ProviderType[] {
      return Array.from(registry.keys());
    },

    invalidateProviderModelCache(type: ProviderType, userId?: string): void {
      registry.get(type)?.invalidateModelCache?.(userId);
      this.invalidateProviderRoutingCache(userId);
    },

    clearRegistry(): void {
      registry.clear();
      providerRouteCache.clear();
    },

    async getProviderForModel(modelName: string, userId: string): Promise<AIProvider> {
      const cachedProviderType = getCachedProviderRoute(providerRouteCache, userId, modelName);
      if (cachedProviderType) {
        recordProviderCacheHit(cachedProviderType, 'provider-route');
        return this.getProvider(cachedProviderType);
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
            setCachedProviderRoute(providerRouteCache, userId, modelName, providerType);
            return this.getProvider(providerType);
          }
        } catch {
          registryLogger.warn('malformed_enabled_models', { provider: row.provider });
        }
      }

      throw new Error(
        `[registry] No connector found for model "${modelName}". Configure a connector that includes this model.`
      );
    },
  };
}

const providerRegistry = createProviderRegistry();

export function createProviderRegistryForTests(dbAccessor?: typeof getDb): ProviderRegistry {
  return createProviderRegistry(dbAccessor);
}

export function invalidateProviderRoutingCache(userId?: string): void {
  providerRegistry.invalidateProviderRoutingCache(userId);
}

/**
 * Registers an AI provider. Calling this again with the same type replaces
 * the existing registration (useful in tests).
 */
export function registerProvider(provider: AIProvider): void {
  providerRegistry.registerProvider(provider);
}

/**
 * Returns the registered provider for the given type.
 * Throws if the provider has not been registered.
 */
export function getProvider(type: ProviderType): AIProvider {
  return providerRegistry.getProvider(type);
}

/**
 * Returns the list of all currently registered provider types.
 */
export function listRegisteredProviderTypes(): ProviderType[] {
  return providerRegistry.listRegisteredProviderTypes();
}

/**
 * Clears the cached model listing for a single provider.
 */
export function invalidateProviderModelCache(type: ProviderType, userId?: string): void {
  providerRegistry.invalidateProviderModelCache(type, userId);
}

/**
 * Removes all registered providers. Intended for test isolation only.
 */
export function clearRegistry(): void {
  providerRegistry.clearRegistry();
}

/**
 * Resolves the provider responsible for a given model by looking up the
 * connector that has the model enabled in secret_metadata.
 */
// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function getProviderForModel(modelName: string, userId: string): Promise<AIProvider> {
  return providerRegistry.getProviderForModel(modelName, userId);
}
