/**
 * AIProvider adapter for the official OpenAI API.
 * Always uses https://api.openai.com/v1. For custom endpoints use openai-compatible/.
 *
 * Validation and runtime both use the same OpenAI auth context (apiKey +
 * optional organizationId / projectId) so that project-scoped keys are never
 * rejected during connector setup.
 */

import { registerProvider } from '../core/provider-registry';
import { isReasoningModel } from '../core/capability-detector';
import { createOpenAIClient, validateOpenAIAuthContext, type OpenAIAuthContext } from './client';
import { secretService, listModelsWithCache, resolveAuthContext } from './model-catalog';
import { buildChatMessages } from './message-mapper';
import { streamWithResponsesAPI, streamAgentTurnWithResponsesAPI } from './responses-stream';
import { generateOpenAIImage } from './image-generation';
import { extractReasoningFromCompleted, extractReasoningChunks } from './normalizers';
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

// Re-export for backward compatibility with test imports and external consumers
export { validateOpenAIAuthContext, type OpenAIAuthContext };
export { OpenAIAuthError, OpenAIConfigError } from './client';
export { extractReasoningFromCompleted, extractReasoningChunks };
export { streamWithResponsesAPI } from './responses-stream';

const openAIProvider: AIProvider = {
  providerType: 'openai',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createOpenAIClient(ctx);

    const completion = await client.chat.completions.create(
      { model: req.modelName, messages: buildChatMessages(req), stream: false },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createOpenAIClient(ctx);

    if (isReasoningModel(req.modelName) && req.generationConfig?.thinkingEnabled) {
      yield* streamWithResponsesAPI(client, req);
    } else {
      const stream = await client.chat.completions.create(
        { model: req.modelName, messages: buildChatMessages(req), stream: true },
        { signal: req.signal }
      );
      for await (const chunk of stream) {
        if (req.signal?.aborted) break;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield { type: 'text', text: delta, done: false };
      }
      yield { type: 'text', text: '', done: true };
    }
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createOpenAIClient(ctx);
    yield* streamAgentTurnWithResponsesAPI(client, req);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createOpenAIClient(ctx);
    return generateOpenAIImage(client, req);
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache(userId?: string): void {
    listModelsWithCache.invalidate(userId);
  },

  async syncConfigFileConnectors(userId: string): Promise<void> {
    await secretService.syncConfigFileConnectors(userId);
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await validateOpenAIAuthContext({ apiKey });
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { apiKey } = await resolveAuthContext(userId, modelName);
    return apiKey;
  },
};

// Self-register on import
registerProvider(openAIProvider);

export { openAIProvider };
