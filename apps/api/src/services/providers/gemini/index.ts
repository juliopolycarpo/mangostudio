/**
 * AIProvider adapter for Google Gemini.
 * Merges the agentic Interactions API path with the non-agentic text and image generation.
 */

import { registerProvider } from '../core/provider-registry';
import { isReasoningModel } from '../core/capability-detector';
import {
  getResolvedGeminiApiKey,
  syncGeminiConfigFileConnectors,
  validateGeminiApiKey,
} from './secret';
import { getGeminiModelCatalog, clearGeminiModelCatalog } from './model-catalog';
import { generateGeminiText, generateGeminiTextStream } from './text';
import { generateGeminiImage } from './image-generation';
import { streamGeminiAgentTurn } from './interactions-stream';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingChunk,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
  AgentTurnRequest,
  AgentEvent,
} from '../types';

const geminiProvider: AIProvider = {
  providerType: 'gemini',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const text = await generateGeminiText(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName
    );
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    for await (const chunk of generateGeminiTextStream(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName,
      req.generationConfig
    )) {
      if (req.signal?.aborted) break;
      yield chunk;
    }
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    yield* streamGeminiAgentTurn(req);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const imageUrl = await generateGeminiImage(
      req.userId,
      req.prompt,
      req.systemPrompt,
      req.referenceImageUrl,
      req.imageSize ?? '1K',
      req.modelName
    );
    return { imageUrl };
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    const catalog = await getGeminiModelCatalog(userId);
    return catalog.allModels.map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      description: m.description,
      provider: 'gemini' as const,
      inputTokenLimit: m.inputTokenLimit,
      capabilities: {
        text: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        image: catalog.discoveredImageModels.some((i) => i.modelId === m.modelId),
        streaming: true,
        reasoning: isReasoningModel(m.modelId),
        tools: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        statefulContinuation: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        promptCaching: true,
        parallelToolCalls: false,
        reasoningWithTools: isReasoningModel(m.modelId),
      },
    }));
  },

  invalidateModelCache(userId?: string): void {
    if (userId) {
      clearGeminiModelCatalog(userId);
    }
  },

  async syncConfigFileConnectors(userId: string): Promise<void> {
    await syncGeminiConfigFileConnectors(userId);
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await validateGeminiApiKey(apiKey);
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    return getResolvedGeminiApiKey(userId, modelName);
  },
};

// Self-register on import
registerProvider(geminiProvider);

export { geminiProvider };
