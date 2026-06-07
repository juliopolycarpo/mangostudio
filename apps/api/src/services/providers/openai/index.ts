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
  ModelInfo,
  ProviderHealthcheckRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { createOpenAIClient, type OpenAIAuthContext, validateOpenAIAuthContext } from './client';
import { generateOpenAIImage } from './image-generation';
import { buildChatMessages } from './message-mapper';
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

interface PreparedOpenAIRuntime {
  readonly authContext: OpenAIAuthContext;
  readonly client: ReturnType<typeof createOpenAIClient>;
}

async function loadPreparedRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedOpenAIRuntime> {
  const authContext = await resolveAuthContext(userId, modelName);
  return {
    authContext,
    client: createOpenAIClient(authContext),
  };
}

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

    const completion = await client.chat.completions.create(
      { model: req.modelName, messages: buildChatMessages(req), stream: false },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);

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
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    yield* streamAgentTurnWithResponsesAPI(client, req);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    return generateOpenAIImage(client, req);
  },

  listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache: lifecycle.invalidateModelCache,
  syncConfigFileConnectors: lifecycle.syncConfigFileConnectors,
  warmup: lifecycle.warmup,

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
