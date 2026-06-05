/**
 * AIProvider adapter for Google Gemini.
 * Merges the agentic Interactions API path with the non-agentic text and image generation.
 */

import { isReasoningModel } from '../core/capability-detector';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';
import { createReadinessCache, createReadinessCacheKey } from '../core/readiness-cache';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
  ProviderHealthcheckRequest,
  ProviderWarmupRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { createGeminiClient } from './client';
import { generateGeminiImage } from './image-generation';
import { streamGeminiAgentTurn } from './interactions-stream';
import { clearGeminiModelCatalog, getGeminiModelCatalog } from './model-catalog';
import {
  getResolvedGeminiApiKey,
  syncGeminiConfigFileConnectors,
  validateGeminiApiKey,
} from './secret';
import { generateGeminiText, generateGeminiTextStream } from './text';

interface PreparedGeminiRuntime {
  readonly apiKey: string;
  readonly client: ReturnType<typeof createGeminiClient>;
}

const preparedRuntimeCache = createReadinessCache<PreparedGeminiRuntime>({
  onHit: () => recordProviderCacheHit('gemini', 'prepared-runtime'),
  onMiss: () => recordProviderCacheMiss('gemini', 'prepared-runtime'),
});

async function loadPreparedRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedGeminiRuntime> {
  const apiKey = await getResolvedGeminiApiKey(userId, modelName);
  return {
    apiKey,
    client: createGeminiClient(apiKey),
  };
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
async function prepareRuntime(userId: string, modelName?: string): Promise<PreparedGeminiRuntime> {
  return preparedRuntimeCache.get(createReadinessCacheKey(userId, modelName), () =>
    loadPreparedRuntime(userId, modelName)
  );
}

function invalidatePreparedRuntime(userId?: string): void {
  if (!userId) {
    preparedRuntimeCache.clearWhere(() => true);
    return;
  }

  preparedRuntimeCache.clearByUserPrefix(userId);
}

const geminiProvider: AIProvider = {
  providerType: 'gemini',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await prepareRuntime(req.userId, req.modelName);
    const text = await generateGeminiText(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName,
      { attachments: req.attachments, modelCapabilities: req.modelCapabilities },
      client
    );
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await prepareRuntime(req.userId, req.modelName);
    for await (const chunk of generateGeminiTextStream(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName,
      req.generationConfig,
      { attachments: req.attachments, modelCapabilities: req.modelCapabilities },
      client
    )) {
      if (req.signal?.aborted) break;
      yield chunk;
    }
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const { client } = await prepareRuntime(req.userId, req.modelName);
    yield* streamGeminiAgentTurn(req, client);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { client } = await prepareRuntime(req.userId, req.modelName);
    const imageUrl = await generateGeminiImage(
      req.userId,
      req.prompt,
      req.systemPrompt,
      req.referenceImageUrl,
      req.imageSize ?? '1K',
      req.modelName,
      client
    );
    return { imageUrl };
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    const catalog = await getGeminiModelCatalog(userId);
    return catalog.allModels.map((m) => {
      const isText = catalog.discoveredTextModels.some((t) => t.modelId === m.modelId);
      const isImage = catalog.discoveredImageModels.some((i) => i.modelId === m.modelId);

      return {
        modelId: m.modelId,
        displayName: m.displayName,
        description: m.description,
        provider: 'gemini' as const,
        inputTokenLimit: m.inputTokenLimit,
        capabilities: {
          text: isText,
          image: isImage,
          streaming: true,
          reasoning: isReasoningModel(m.modelId),
          tools: isText,
          statefulContinuation: isText,
          promptCaching: true,
          parallelToolCalls: false,
          reasoningWithTools: isReasoningModel(m.modelId),
          structuredOutput: isText,
          fileAttachments: isText,
          imageInput: isText,
          pdfInput: isText,
          textFileInput: isText,
        },
      };
    });
  },

  invalidateModelCache(userId?: string): void {
    if (userId) {
      clearGeminiModelCatalog(userId);
    }
    invalidatePreparedRuntime(userId);
  },

  async syncConfigFileConnectors(userId: string): Promise<void> {
    await syncGeminiConfigFileConnectors(userId);
  },

  async warmup(req: ProviderWarmupRequest): Promise<void> {
    await preparedRuntimeCache.prime(createReadinessCacheKey(req.userId, req.modelName), () =>
      loadPreparedRuntime(req.userId, req.modelName)
    );
  },

  async healthcheck(req: ProviderHealthcheckRequest): Promise<void> {
    if (!req.apiKey?.trim()) {
      throw new Error('gemini healthcheck requires an API key.');
    }

    await validateGeminiApiKey(req.apiKey.trim());
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await validateGeminiApiKey(apiKey);
  },

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    return getResolvedGeminiApiKey(userId, modelName);
  },
};

export { geminiProvider };
