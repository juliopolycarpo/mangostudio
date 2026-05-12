/**
 * AIProvider adapter for the official OpenAI API.
 * Always uses https://api.openai.com/v1. For custom endpoints use openai-compatible/.
 *
 * Validation and runtime both use the same OpenAI auth context (apiKey +
 * optional organizationId / projectId) so that project-scoped keys are never
 * rejected during connector setup.
 */

import { registerProvider } from '../core/provider-registry';
import { createReadinessCache, createReadinessCacheKey } from '../core/readiness-cache';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';
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
  ProviderHealthcheckRequest,
  ProviderWarmupRequest,
} from '../types';

// Re-export for backward compatibility with test imports and external consumers
export { validateOpenAIAuthContext, type OpenAIAuthContext };
export { OpenAIAuthError, OpenAIConfigError } from './client';
export { extractReasoningFromCompleted, extractReasoningChunks };
export { streamWithResponsesAPI } from './responses-stream';

interface PreparedOpenAIRuntime {
  readonly authContext: OpenAIAuthContext;
  readonly client: ReturnType<typeof createOpenAIClient>;
}

const preparedRuntimeCache = createReadinessCache<PreparedOpenAIRuntime>({
  onHit: () => recordProviderCacheHit('openai', 'prepared-runtime'),
  onMiss: () => recordProviderCacheMiss('openai', 'prepared-runtime'),
});

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

async function prepareRuntime(userId: string, modelName?: string): Promise<PreparedOpenAIRuntime> {
  const cacheKey = createReadinessCacheKey(userId, modelName);
  return preparedRuntimeCache.get(cacheKey, () => loadPreparedRuntime(userId, modelName));
}

function invalidatePreparedRuntime(userId?: string): void {
  if (!userId) {
    preparedRuntimeCache.clearWhere(() => true);
    return;
  }

  preparedRuntimeCache.clearByUserPrefix(userId);
}

const openAIProvider: AIProvider = {
  providerType: 'openai',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await prepareRuntime(req.userId, req.modelName);

    const completion = await client.chat.completions.create(
      { model: req.modelName, messages: buildChatMessages(req), stream: false },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await prepareRuntime(req.userId, req.modelName);

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
    const { client } = await prepareRuntime(req.userId, req.modelName);
    yield* streamAgentTurnWithResponsesAPI(client, req);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { client } = await prepareRuntime(req.userId, req.modelName);
    return generateOpenAIImage(client, req);
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache(userId?: string): void {
    listModelsWithCache.invalidate(userId);
    invalidatePreparedRuntime(userId);
  },

  async syncConfigFileConnectors(userId: string): Promise<void> {
    await secretService.syncConfigFileConnectors(userId);
  },

  async warmup(req: ProviderWarmupRequest): Promise<void> {
    await preparedRuntimeCache.prime(createReadinessCacheKey(req.userId, req.modelName), () =>
      loadPreparedRuntime(req.userId, req.modelName)
    );
  },

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

// Self-register on import
registerProvider(openAIProvider);

export { openAIProvider };
