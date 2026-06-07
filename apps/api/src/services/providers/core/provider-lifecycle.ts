import type { ProviderType } from '@mangostudio/shared/types';
import type { ProviderWarmupRequest } from '../types';
import { recordProviderCacheHit, recordProviderCacheMiss } from './provider-observability';
import { createReadinessCache, createReadinessCacheKey } from './readiness-cache';

interface ProviderLifecycleConfig<TPreparedRuntime> {
  provider: ProviderType;
  loadPreparedRuntime(userId: string, modelName?: string): Promise<TPreparedRuntime>;
  invalidateCachedModels?(userId?: string): void;
  syncConfigFileConnectors?(userId: string): Promise<void>;
}

interface ProviderLifecycle<TPreparedRuntime> {
  prepareRuntime(userId: string, modelName?: string): Promise<TPreparedRuntime>;
  invalidateModelCache(userId?: string): void;
  syncConfigFileConnectors(userId: string): Promise<void>;
  warmup(req: ProviderWarmupRequest): Promise<void>;
}

/**
 * Shares the cache-backed provider lifecycle glue without hiding provider-specific runtime loading.
 * Usage: const lifecycle = createProviderLifecycle({ provider: 'openai', loadPreparedRuntime });
 */
export function createProviderLifecycle<TPreparedRuntime>(
  config: ProviderLifecycleConfig<TPreparedRuntime>
): ProviderLifecycle<TPreparedRuntime> {
  const preparedRuntimeCache = createReadinessCache<TPreparedRuntime>({
    onHit: () => recordProviderCacheHit(config.provider, 'prepared-runtime'),
    onMiss: () => recordProviderCacheMiss(config.provider, 'prepared-runtime'),
  });

  const prepareRuntime = (userId: string, modelName?: string): Promise<TPreparedRuntime> => {
    return preparedRuntimeCache.get(createReadinessCacheKey(userId, modelName), () =>
      config.loadPreparedRuntime(userId, modelName)
    );
  };

  const invalidatePreparedRuntime = (userId?: string): void => {
    if (!userId) {
      preparedRuntimeCache.clearWhere(() => true);
      return;
    }

    preparedRuntimeCache.clearByUserPrefix(userId);
  };

  const invalidateModelCache = (userId?: string): void => {
    config.invalidateCachedModels?.(userId);
    invalidatePreparedRuntime(userId);
  };

  const syncConfigFileConnectors = (userId: string): Promise<void> => {
    return config.syncConfigFileConnectors?.(userId) ?? Promise.resolve();
  };

  const warmup = (req: ProviderWarmupRequest): Promise<void> => {
    return preparedRuntimeCache.prime(createReadinessCacheKey(req.userId, req.modelName), () =>
      config.loadPreparedRuntime(req.userId, req.modelName)
    );
  };

  return {
    prepareRuntime,
    invalidateModelCache,
    syncConfigFileConnectors,
    warmup,
  };
}
