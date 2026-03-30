/**
 * Unified model catalog service.
 * Aggregates models from all registered providers into a single catalog
 * with per-user caching and TTL-based refresh.
 */

import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared';
import { listRegisteredProviderTypes, getProvider } from './registry';
import { listSecretMetadata } from '../secret-store/metadata';
import type { ModelInfo, AIProvider } from './types';
import type { ProviderType } from '@mangostudio/shared/types';

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CATALOG_ENTRIES = 1000;

interface UnifiedModelCatalogDeps {
  now?: () => number;
  /** Overrides listRegisteredProviderTypes (useful in tests). */
  listProviders?: () => ProviderType[];
  /** Overrides getProvider (useful in tests). */
  getProviderFn?: (type: ProviderType) => AIProvider;
  /** Overrides listSecretMetadata (useful in tests). */
  listSecretMetadataFn?: typeof listSecretMetadata;
}

function modelInfoToOption(m: ModelInfo): ModelOption {
  return {
    modelId: m.modelId,
    resourceName: m.modelId,
    displayName: m.displayName,
    description: m.description,
    supportedActions: [],
    provider: m.provider,
    capabilities: m.capabilities,
  };
}

function createEmptySnapshot(): ModelCatalogResponse {
  return {
    configured: false,
    status: 'idle',
    allModels: [],
    textModels: [],
    imageModels: [],
    discoveredTextModels: [],
    discoveredImageModels: [],
  };
}

/**
 * Creates a unified model catalog service that aggregates models from all
 * registered AI providers.
 */
function evictOldest<V>(map: Map<string, V>): void {
  if (map.size > MAX_CATALOG_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
}

export function createUnifiedModelCatalogService(deps: UnifiedModelCatalogDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const listProviders = deps.listProviders ?? listRegisteredProviderTypes;
  const getProviderFn = deps.getProviderFn ?? getProvider;
  const listSecretMetadataFn = deps.listSecretMetadataFn ?? listSecretMetadata;

  // Per-user cache: full discovered models (before filtering by enabled)
  const fullCatalogs = new Map<string, ModelOption[]>();
  const snapshots = new Map<string, ModelCatalogResponse>();
  const refreshPromises = new Map<string, Promise<ModelCatalogResponse>>();

  function getSnapshot(userId: string): ModelCatalogResponse {
    if (!snapshots.has(userId)) snapshots.set(userId, createEmptySnapshot());
    return snapshots.get(userId)!;
  }

  function isStale(userId: string): boolean {
    const snap = getSnapshot(userId);
    const full = fullCatalogs.get(userId);
    if (!full || full.length === 0) return true;
    if (!snap.lastSyncedAt) return true;
    return now() - snap.lastSyncedAt > TTL_MS;
  }

  /** Collects the set of model IDs enabled across all connectors for a user. */
  async function getEnabledModelIds(userId: string): Promise<Set<string>> {
    const enabled = new Set<string>();
    const providerTypes = listProviders();

    for (const pt of providerTypes) {
      const connectors = await listSecretMetadataFn(pt, userId);
      for (const c of connectors) {
        try {
          const models: string[] = JSON.parse(c.enabledModels);
          models.forEach((m) => enabled.add(m));
        } catch {
          // Ignore parse errors
        }
      }
    }

    return enabled;
  }

  async function recalculateSnapshot(userId: string): Promise<void> {
    const enabledIds = await getEnabledModelIds(userId);
    const fullCatalog = fullCatalogs.get(userId) || [];
    const snap = getSnapshot(userId);

    const discoveredText = fullCatalog.filter((m) => m.capabilities?.text);
    const discoveredImage = fullCatalog.filter((m) => m.capabilities?.image);

    snapshots.set(userId, {
      ...snap,
      configured: true,
      status: 'ready',
      allModels: fullCatalog,
      discoveredTextModels: discoveredText,
      discoveredImageModels: discoveredImage,
      textModels: discoveredText.filter((m) => enabledIds.has(m.modelId)),
      imageModels: discoveredImage.filter((m) => enabledIds.has(m.modelId)),
    });
  }

  return {
    /**
     * Refreshes the catalog by calling listModels() on every registered provider.
     * Providers that fail (e.g. no connector configured) are silently skipped.
     */
    async refresh(userId: string): Promise<ModelCatalogResponse> {
      if (refreshPromises.has(userId)) return refreshPromises.get(userId)!;

      const promise = (async () => {
        try {
          const providerTypes = listProviders();
          const PROVIDER_TIMEOUT_MS = 5_000;

          const results = await Promise.allSettled(
            providerTypes.map(async (pt) => {
              const provider = getProviderFn(pt);
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Provider ${pt} timed out`)), PROVIDER_TIMEOUT_MS)
              );
              return Promise.race([provider.listModels(userId), timeoutPromise]);
            })
          );

          const allModels: ModelOption[] = [];
          for (const result of results) {
            if (result.status === 'fulfilled') {
              allModels.push(...result.value.map(modelInfoToOption));
            }
            // rejected providers (no connector or timeout) are silently skipped
          }

          fullCatalogs.set(userId, allModels);
          evictOldest(fullCatalogs);
          await recalculateSnapshot(userId);

          const snap = getSnapshot(userId);
          snap.lastSyncedAt = now();
          snapshots.set(userId, snap);
          evictOldest(snapshots);

          return snap;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown catalog refresh error.';
          const snap: ModelCatalogResponse = {
            ...createEmptySnapshot(),
            status: 'error',
            error: message,
          };
          snapshots.set(userId, snap);
          return snap;
        } finally {
          refreshPromises.delete(userId);
        }
      })();

      refreshPromises.set(userId, promise);
      return promise;
    },

    /**
     * Returns the catalog, awaiting the first refresh when the cache is cold.
     * Subsequent calls with a warm cache recalculate the snapshot synchronously.
     */
    async getUnifiedModelCatalog(userId: string): Promise<ModelCatalogResponse> {
      const full = fullCatalogs.get(userId);
      if (full && full.length > 0) {
        await recalculateSnapshot(userId);
      } else if (isStale(userId)) {
        return this.refresh(userId);
      }
      return getSnapshot(userId);
    },

    /** Invalidates the cached catalog for a user, forcing a refresh on next access. */
    invalidate(userId: string): void {
      fullCatalogs.delete(userId);
      snapshots.delete(userId);
    },
  };
}

const unifiedCatalogService = createUnifiedModelCatalogService();

export const refreshUnifiedCatalog = unifiedCatalogService.refresh.bind(unifiedCatalogService);
export const getUnifiedModelCatalog =
  unifiedCatalogService.getUnifiedModelCatalog.bind(unifiedCatalogService);
export const invalidateUnifiedCatalog =
  unifiedCatalogService.invalidate.bind(unifiedCatalogService);
