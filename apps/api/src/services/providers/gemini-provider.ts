/**
 * AIProvider adapter that wraps the existing Gemini service functions.
 * Delegates to services/gemini/* without duplicating any logic.
 */

import {
  clearGeminiModelCatalog,
  generateText as geminiGenerateText,
  generateTextStream as geminiGenerateTextStream,
  generateImage as geminiGenerateImage,
  getResolvedGeminiApiKey,
  syncGeminiConfigFileConnectors,
  validateGeminiApiKey,
  getGeminiModelCatalog,
} from '../gemini';
import { registerProvider } from './registry';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingTextChunk,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
} from './types';

const geminiProvider: AIProvider = {
  providerType: 'gemini',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const text = await geminiGenerateText(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName
    );
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingTextChunk> {
    for await (const chunk of geminiGenerateTextStream(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName
    )) {
      if (req.signal?.aborted) break;
      yield chunk;
    }
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const imageUrl = await geminiGenerateImage(
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
      capabilities: {
        text: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        image: catalog.discoveredImageModels.some((i) => i.modelId === m.modelId),
        streaming: true,
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
