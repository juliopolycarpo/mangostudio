/**
 * AIProvider adapter for the official OpenAI API.
 * Always uses https://api.openai.com/v1. For custom endpoints use openai-compatible/.
 *
 * Validation and runtime both use the same OpenAI auth context (apiKey +
 * optional organizationId / projectId) so that project-scoped keys are never
 * rejected during connector setup.
 */

import { isReasoningModel } from '../core/capability-detector';
import { createProviderLifecycle } from '../core/provider-lifecycle';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  ProviderHealthcheckRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { generateChatCompletionText, streamChatCompletionText } from './chat-completions';
import { createOpenAIClient, type OpenAIAuthContext, validateOpenAIAuthContext } from './client';
import {
  createOpenAIClientRuntimeLoader,
  createOpenAIProviderLifecycleHandlers,
  type OpenAIClientRuntime,
} from './client-runtime';
import { generateImageWithOpenAIClient } from './image-generation';
import { listModelsWithCache, resolveAuthContext, secretService } from './model-catalog';
import { extractReasoningChunks, extractReasoningFromCompleted } from './normalizers';
import { streamAgentTurnWithResponsesAPI, streamWithResponsesAPI } from './responses-stream';

export { OpenAIAuthError, OpenAIConfigError } from './client';
export { streamWithResponsesAPI } from './responses-stream';
// Re-export for backward compatibility with test imports and external consumers
export {
  extractReasoningChunks,
  extractReasoningFromCompleted,
  type OpenAIAuthContext,
  validateOpenAIAuthContext,
};

type PreparedOpenAIRuntime = OpenAIClientRuntime<OpenAIAuthContext>;

const loadPreparedRuntime = createOpenAIClientRuntimeLoader(resolveAuthContext, createOpenAIClient);

const lifecycle = createProviderLifecycle<PreparedOpenAIRuntime>({
  provider: 'openai',
  loadPreparedRuntime,
  invalidateCachedModels: listModelsWithCache.invalidate,
  syncConfigFileConnectors: secretService.syncConfigFileConnectors,
});

const openAIProvider: AIProvider = {
  providerType: 'openai',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    return generateChatCompletionText(client, req, 'No text returned from OpenAI API.');
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);

    if (isReasoningModel(req.modelName) && req.generationConfig?.thinkingEnabled) {
      yield* streamWithResponsesAPI(client, req);
    } else {
      yield* streamChatCompletionText(client, req);
    }
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    yield* streamAgentTurnWithResponsesAPI(client, req);
  },

  generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return generateImageWithOpenAIClient(lifecycle.prepareRuntime, req);
  },

  listModels: listModelsWithCache,
  ...createOpenAIProviderLifecycleHandlers(lifecycle),

  async healthcheck(req: ProviderHealthcheckRequest): Promise<void> {
    if (!req.apiKey?.trim()) {
      throw new Error('openai healthcheck requires an API key.');
    }

    await validateOpenAIAuthContext({
      apiKey: req.apiKey.trim(),
      organizationId: req.organizationId,
      projectId: req.projectId,
    });
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await validateOpenAIAuthContext({ apiKey });
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { apiKey } = await resolveAuthContext(userId, modelName);
    return apiKey;
  },
};

export { openAIProvider };
