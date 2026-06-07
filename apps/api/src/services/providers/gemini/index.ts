/**
 * AIProvider adapter for Google Gemini.
 * Merges the agentic Interactions API path with the non-agentic text and image generation.
 */

import { isReasoningModel } from '../core/capability-detector';
import { createProviderLifecycle } from '../core/provider-lifecycle';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
  ProviderHealthcheckRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { createGeminiClient } from './client';
import { generateGeminiImage } from './image-generation';
import { streamGeminiAgentTurn } from './interactions-stream';
import {
  clearAllGeminiModelCatalogs,
  clearGeminiModelCatalog,
  getGeminiModelCatalog,
} from './model-catalog';
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

const lifecycle = createProviderLifecycle<PreparedGeminiRuntime>({
  provider: 'gemini',
  loadPreparedRuntime,
  invalidateCachedModels: (userId?: string) => {
    if (userId) {
      clearGeminiModelCatalog(userId);
      return;
    }

    clearAllGeminiModelCatalogs();
  },
  syncConfigFileConnectors: syncGeminiConfigFileConnectors,
});

const geminiProvider: AIProvider = {
  providerType: 'gemini',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
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
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
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
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    yield* streamGeminiAgentTurn(req, client);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
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

  invalidateModelCache: lifecycle.invalidateModelCache,
  syncConfigFileConnectors: lifecycle.syncConfigFileConnectors,
  warmup: lifecycle.warmup,

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
