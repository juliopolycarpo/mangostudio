/**
 * Runtime Gemini model catalog discovery and in-memory caching per user.
 * Integrated with multi-connector metadata for model filtering.
 */

import type { Model } from '@google/genai';
import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared';
import { isImageModelId } from '../core/capability-detector';
import { GeminiApiKeyMissingError } from './secret';
import { listSecretMetadata, GEMINI_PROVIDER } from '../../secret-store/metadata';
import { parseStringArray } from '../../../utils/json';
import { createGeminiClient } from './client';

export type GeminiModelCatalogRefreshReason = 'startup' | 'secret-updated' | 'manual' | 'ttl';

interface GeminiModelCatalogServiceDependencies {
  getApiKey?: (userId: string) => Promise<string>;
  listModels?: (apiKey: string) => Promise<Model[]>;
  now?: () => number;
}

function extractModelId(resourceName: string): string {
  return resourceName.split('/').pop() ?? resourceName;
}

function normalizeModelOption(model: Model): ModelOption {
  const resourceName = model.name ?? '';
  const modelWithBaseId = model as Model & { baseModelId?: string };
  const modelId = modelWithBaseId.baseModelId?.trim() || extractModelId(resourceName);

  return {
    modelId,
    resourceName,
    displayName: model.displayName ?? modelId,
    description: model.description ?? undefined,
    version: model.version ?? undefined,
    supportedActions: model.supportedActions ?? [],
    inputTokenLimit: model.inputTokenLimit ?? undefined,
  };
}

function isTextModel(model: ModelOption): boolean {
  return model.supportedActions.includes('generateContent') && !isImageModelId(model.modelId);
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

interface GeminiModelCatalogService {
  refreshGeminiModelCatalog(
    userId: string,
    reason: GeminiModelCatalogRefreshReason
  ): Promise<ModelCatalogResponse>;
  refreshIfStale(userId: string, reason: GeminiModelCatalogRefreshReason): ModelCatalogResponse;
  clearGeminiModelCatalog(userId: string): ModelCatalogResponse;
  getGeminiModelCatalog(userId: string): Promise<ModelCatalogResponse>;
  getDefaultTextModel(userId: string): string;
  getDefaultImageModel(userId: string): string;
  hasTextModel(userId: string, modelId: string): boolean;
  hasImageModel(userId: string, modelId: string): boolean;
}

/**
 * Creates the Gemini model catalog service with injectable dependencies for tests.
 */
export function createGeminiModelCatalogService(
  dependencies: GeminiModelCatalogServiceDependencies = {}
): GeminiModelCatalogService {
  const { getApiKey: getApiKeyDep, now: nowDep, listModels: listModelsDep } = dependencies;

  const now = nowDep ?? (() => Date.now());

  const fullCatalogs = new Map<string, ModelOption[]>();
  const snapshots = new Map<string, ModelCatalogResponse>();
  const refreshPromises = new Map<string, Promise<ModelCatalogResponse>>();
  const TTL_MS = 60 * 60 * 1000; // 1 hour

  function getSnapshot(userId: string): ModelCatalogResponse {
    const existing = snapshots.get(userId);
    if (existing) return existing;
    const fresh = createEmptySnapshot();
    snapshots.set(userId, fresh);
    return fresh;
  }

  function getFullCatalog(userId: string): ModelOption[] {
    return fullCatalogs.get(userId) || [];
  }

  function isStale(userId: string): boolean {
    const catalog = getFullCatalog(userId);
    const snap = getSnapshot(userId);
    if (catalog.length === 0) return true;
    if (!snap.lastSyncedAt) return true;
    return now() - snap.lastSyncedAt > TTL_MS;
  }

  async function getEnabledModelIds(userId: string): Promise<Set<string>> {
    const connectors = await listSecretMetadata(GEMINI_PROVIDER, userId);
    const enabled = new Set<string>();
    for (const c of connectors) {
      try {
        const models = parseStringArray(c.enabledModels);
        models.forEach((m) => enabled.add(m));
      } catch {
        // Ignore parse errors
      }
    }
    return enabled;
  }

  const recalculateSnapshot = async (userId: string): Promise<void> => {
    const enabledIds = await getEnabledModelIds(userId);
    const fullCatalog = getFullCatalog(userId);
    const snap = getSnapshot(userId);

    snapshots.set(userId, {
      ...snap,
      configured: true,
      status: 'ready',
      allModels: fullCatalog,
      discoveredTextModels: fullCatalog.filter(isTextModel),
      discoveredImageModels: fullCatalog.filter((m) => isImageModelId(m.modelId)),
      textModels: fullCatalog.filter((m) => isTextModel(m) && enabledIds.has(m.modelId)),
      imageModels: fullCatalog.filter(
        (m) => isImageModelId(m.modelId) && enabledIds.has(m.modelId)
      ),
    });
  };

  // Resolve lazily to avoid circular dependency at module load time
  const resolveApiKey = async (userId: string): Promise<string> => {
    if (getApiKeyDep) return getApiKeyDep(userId);
    const { getResolvedGeminiApiKey } = await import('./secret');
    return getResolvedGeminiApiKey(userId);
  };

  const fetchModels = async (apiKey: string): Promise<Model[]> => {
    if (listModelsDep) return listModelsDep(apiKey);
    const ai = createGeminiClient(apiKey);
    const pager = await ai.models.list();
    const models: Model[] = [];
    for await (const model of pager) {
      models.push(model);
    }
    return models;
  };

  return {
    async refreshGeminiModelCatalog(
      userId: string,
      _reason: GeminiModelCatalogRefreshReason
    ): Promise<ModelCatalogResponse> {
      const inflight = refreshPromises.get(userId);
      if (inflight) return inflight;

      const refreshPromise = (async () => {
        try {
          const apiKey = await resolveApiKey(userId);
          const discovered = (await fetchModels(apiKey))
            .map(normalizeModelOption)
            .sort((left, right) => left.displayName.localeCompare(right.displayName));

          fullCatalogs.set(userId, discovered);
          await recalculateSnapshot(userId);

          const snap = getSnapshot(userId);
          snap.lastSyncedAt = now();
          snapshots.set(userId, snap);

          return snap;
        } catch (error) {
          if (error instanceof GeminiApiKeyMissingError) {
            const snap = createEmptySnapshot();
            snapshots.set(userId, snap);
            return snap;
          }

          const message =
            error instanceof Error ? error.message : 'Unknown Gemini catalog refresh error.';
          const snap = {
            ...createEmptySnapshot(),
            status: 'error' as const,
            error: message,
          };
          snapshots.set(userId, snap);
          return snap;
        } finally {
          refreshPromises.delete(userId);
        }
      })();

      refreshPromises.set(userId, refreshPromise);
      return refreshPromise;
    },

    refreshIfStale(userId: string, reason: GeminiModelCatalogRefreshReason): ModelCatalogResponse {
      if (isStale(userId) && !refreshPromises.has(userId)) {
        this.refreshGeminiModelCatalog(userId, reason).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[gemini] Catalog refresh failed:', message);
        });
      }
      return getSnapshot(userId);
    },

    clearGeminiModelCatalog(userId: string): ModelCatalogResponse {
      fullCatalogs.set(userId, []);
      const snap = createEmptySnapshot();
      snapshots.set(userId, snap);
      return snap;
    },

    async getGeminiModelCatalog(userId: string): Promise<ModelCatalogResponse> {
      if (getFullCatalog(userId).length > 0) {
        await recalculateSnapshot(userId);
        if (isStale(userId) && !refreshPromises.has(userId)) {
          this.refreshGeminiModelCatalog(userId, 'ttl').catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[gemini] Background catalog refresh failed:', message);
          });
        }
      } else {
        return this.refreshGeminiModelCatalog(userId, 'ttl');
      }
      return getSnapshot(userId);
    },

    getDefaultTextModel(userId: string): string {
      return getSnapshot(userId).textModels[0]?.modelId ?? '';
    },

    getDefaultImageModel(userId: string): string {
      return getSnapshot(userId).imageModels[0]?.modelId ?? '';
    },

    hasTextModel(userId: string, modelId: string): boolean {
      return getSnapshot(userId).textModels.some((model) => model.modelId === modelId);
    },

    hasImageModel(userId: string, modelId: string): boolean {
      return getSnapshot(userId).imageModels.some((model) => model.modelId === modelId);
    },
  };
}

const geminiModelCatalogService = createGeminiModelCatalogService();

export const refreshGeminiModelCatalog =
  geminiModelCatalogService.refreshGeminiModelCatalog.bind(geminiModelCatalogService);
export const refreshIfStale =
  geminiModelCatalogService.refreshIfStale.bind(geminiModelCatalogService);
export const clearGeminiModelCatalog =
  geminiModelCatalogService.clearGeminiModelCatalog.bind(geminiModelCatalogService);
export const getGeminiModelCatalog =
  geminiModelCatalogService.getGeminiModelCatalog.bind(geminiModelCatalogService);
export const getDefaultTextModel =
  geminiModelCatalogService.getDefaultTextModel.bind(geminiModelCatalogService);
export const getDefaultImageModel =
  geminiModelCatalogService.getDefaultImageModel.bind(geminiModelCatalogService);
export const hasTextModel = geminiModelCatalogService.hasTextModel.bind(geminiModelCatalogService);
export const hasImageModel =
  geminiModelCatalogService.hasImageModel.bind(geminiModelCatalogService);
