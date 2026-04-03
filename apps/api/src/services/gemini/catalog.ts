/**
 * Runtime Gemini model catalog discovery and in-memory caching per user.
 * Now integrated with multi-connector metadata for model filtering.
 */

import { GoogleGenAI } from '@google/genai';
import type { Model } from '@google/genai';
import type { GeminiModelCatalogResponse, GeminiModelOption } from '@mangostudio/shared';
import { isImageModelId } from '@mangostudio/shared/utils/model-detection';
import { GeminiApiKeyMissingError, getResolvedGeminiApiKey } from './secret';
import { listSecretMetadata, GEMINI_PROVIDER } from '../secret-store/metadata';

export type GeminiModelCatalogRefreshReason = 'startup' | 'secret-updated' | 'manual' | 'ttl';

interface GeminiModelCatalogServiceDependencies {
  getApiKey?: (userId: string) => Promise<string>;
  listModels?: (apiKey: string) => Promise<Model[]>;
  now?: () => number;
}

function extractModelId(resourceName: string): string {
  return resourceName.split('/').pop() ?? resourceName;
}

function normalizeModelOption(model: Model): GeminiModelOption {
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

function isTextModel(model: GeminiModelOption): boolean {
  return model.supportedActions.includes('generateContent') && !isImageModelId(model.modelId);
}

function createEmptySnapshot(): GeminiModelCatalogResponse {
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
 * Creates the Gemini model catalog service with injectable dependencies for tests.
 */
export function createGeminiModelCatalogService(
  dependencies: GeminiModelCatalogServiceDependencies = {}
) {
  const getApiKey = dependencies.getApiKey ?? (async (userId) => getResolvedGeminiApiKey(userId));
  const now = dependencies.now ?? (() => Date.now());
  const listModels =
    dependencies.listModels ??
    (async (apiKey: string): Promise<Model[]> => {
      const ai = new GoogleGenAI({ apiKey });
      const pager = await ai.models.list();
      const models: Model[] = [];

      for await (const model of pager) {
        models.push(model);
      }

      return models;
    });

  const fullCatalogs = new Map<string, GeminiModelOption[]>();
  const snapshots = new Map<string, GeminiModelCatalogResponse>();
  const refreshPromises = new Map<string, Promise<GeminiModelCatalogResponse>>();
  const TTL_MS = 60 * 60 * 1000; // 1 hour

  function getSnapshot(userId: string) {
    if (!snapshots.has(userId)) snapshots.set(userId, createEmptySnapshot());
    return snapshots.get(userId)!;
  }

  function getFullCatalog(userId: string) {
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
        const models: string[] = JSON.parse(c.enabledModels);
        models.forEach((m) => enabled.add(m));
      } catch {
        // Ignore parse errors
      }
    }
    return enabled;
  }

  const recalculateSnapshot = async (userId: string) => {
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

  return {
    async refreshGeminiModelCatalog(
      userId: string,
      _reason: GeminiModelCatalogRefreshReason
    ): Promise<GeminiModelCatalogResponse> {
      if (refreshPromises.has(userId)) return refreshPromises.get(userId)!;

      const refreshPromise = (async () => {
        try {
          const apiKey = await getApiKey(userId);
          const discovered = (await listModels(apiKey))
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

    refreshIfStale(
      userId: string,
      reason: GeminiModelCatalogRefreshReason
    ): GeminiModelCatalogResponse {
      if (isStale(userId) && !refreshPromises.has(userId)) {
        this.refreshGeminiModelCatalog(userId, reason).catch((err) => {
          console.warn('[gemini] Catalog refresh failed:', err.message);
        });
      }
      return getSnapshot(userId);
    },

    clearGeminiModelCatalog(userId: string): GeminiModelCatalogResponse {
      fullCatalogs.set(userId, []);
      const snap = createEmptySnapshot();
      snapshots.set(userId, snap);
      return snap;
    },

    async getGeminiModelCatalog(userId: string): Promise<GeminiModelCatalogResponse> {
      if (getFullCatalog(userId).length > 0) {
        await recalculateSnapshot(userId);
        // Background refresh if stale — user sees current data while it updates
        if (isStale(userId) && !refreshPromises.has(userId)) {
          this.refreshGeminiModelCatalog(userId, 'ttl').catch((err) => {
            console.warn('[gemini] Background catalog refresh failed:', err.message);
          });
        }
      } else {
        // Cold start: await the first refresh — nothing to show without it
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
