/**
 * AIProvider adapter for OpenAI-compatible APIs.
 * Supports DeepSeek, OpenRouter, and any other OpenAI-compatible endpoint via baseURL.
 * The baseURL is stored per-connector in secret_metadata.baseUrl.
 */

import { validateBaseUrl } from '../core/base-url-policy';
import { isImageModelId, isReasoningModel } from '../core/capability-detector';
import { withModelCache } from '../core/model-cache';
import { PROVIDER_PROBE_TIMEOUT_MS, withAbortTimeout } from '../core/probe-timeout';
import {
  recordProviderCacheHit,
  recordProviderCacheMiss,
  recordProviderProbeTimeout,
} from '../core/provider-observability';
import { registerProvider } from '../core/provider-registry';
import { createReadinessCache, createReadinessCacheKey } from '../core/readiness-cache';
import { createProviderSecretService } from '../core/secret-service';
import { generateOpenAIImage } from '../openai/image-generation';
import { buildChatMessages } from '../openai/message-mapper';
import { extractReasoningChunks } from '../openai/normalizers';
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
import { streamOAICompatAgentTurn } from './chat-completions-stream';
import { createCompatibleClient } from './client';
import { classifyEndpoint } from './endpoint-classifier';
import { resolveCompatibleClientConfig } from './resolve-client-config';

// Re-export for consumers
export { classifyEndpoint, extractReasoningChunks };

const secretService = createProviderSecretService({
  provider: 'openai-compatible',
  tomlSection: 'openai_compatible_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  shouldSyncConfigEntry: ({ existing }) => Boolean(existing?.baseUrl?.trim()),
  validateFn: (_apiKey, _fetchImpl) => {
    return Promise.reject(new Error('Cannot validate an openai-compatible key without a baseUrl.'));
  },
});

/**
 * Resolves the API key and base URL for the connector that has the requested model enabled.
 */
async function resolveClientConfig(
  userId: string,
  modelName?: string
): Promise<{ apiKey: string; baseUrl: string }> {
  const rows = await secretService.listMeta('openai-compatible', userId);
  return resolveCompatibleClientConfig(rows, secretService.resolveSecretValue, modelName);
}

interface PreparedCompatibleRuntime {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly client: ReturnType<typeof createCompatibleClient>;
}

const preparedRuntimeCache = createReadinessCache<PreparedCompatibleRuntime>({
  onHit: () => recordProviderCacheHit('openai-compatible', 'prepared-runtime'),
  onMiss: () => recordProviderCacheMiss('openai-compatible', 'prepared-runtime'),
});

async function loadPreparedRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedCompatibleRuntime> {
  const { apiKey, baseUrl } = await resolveClientConfig(userId, modelName);
  return {
    apiKey,
    baseUrl,
    client: createCompatibleClient(apiKey, baseUrl),
  };
}

async function prepareRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedCompatibleRuntime> {
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

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('openai-compatible', userId);

    const seenBaseUrls = new Map<string, string>();

    for (const row of rows) {
      if (!row.configured) continue;
      if (!row.baseUrl) continue;
      const baseUrl = row.baseUrl;
      if (seenBaseUrls.has(baseUrl)) continue;

      const apiKey = await secretService.resolveSecretValue(row);
      if (apiKey) {
        seenBaseUrls.set(baseUrl, apiKey);
      }
    }

    const allModels: ModelInfo[] = [];

    for (const [baseUrl, apiKey] of seenBaseUrls) {
      try {
        const client = createCompatibleClient(apiKey, baseUrl, {
          timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
          maxRetries: 0,
        });
        const endpoint = classifyEndpoint(baseUrl);
        // OpenRouter and DeepSeek advertise Chat Completions response_format JSON
        // Schema support. Generic endpoints are unknown territory — report false
        // so callers make no assumptions until verified.
        const supportsStructuredOutput = endpoint === 'openrouter' || endpoint === 'deepseek';

        const modelsPage = await withAbortTimeout(
          (signal) => client.models.list({ signal }),
          `OpenAI-compatible model listing timed out for ${baseUrl}.`,
          PROVIDER_PROBE_TIMEOUT_MS,
          () =>
            recordProviderProbeTimeout({
              provider: 'openai-compatible',
              operation: 'model-list',
              message: `OpenAI-compatible model listing timed out for ${baseUrl}.`,
            })
        );
        for await (const model of modelsPage) {
          if (
            model.id.includes('embedding') ||
            model.id.includes('tts') ||
            model.id.includes('whisper') ||
            model.id.includes('moderation')
          ) {
            continue;
          }

          const isImage = isImageModelId(model.id);
          allModels.push({
            modelId: model.id,
            displayName: model.id,
            provider: 'openai-compatible',
            capabilities: {
              text: !isImage,
              image: isImage,
              streaming: !isImage,
              reasoning: isReasoningModel(model.id),
              tools: !isImage,
              statefulContinuation: false,
              promptCaching: false,
              parallelToolCalls: !isImage,
              reasoningWithTools: isReasoningModel(model.id) && !isImage,
              structuredOutput: supportsStructuredOutput && !isImage,
            },
          });
        }
      } catch (err) {
        console.warn(`[openai-compatible] Failed to list models for ${baseUrl}:`, err);
      }
    }

    return allModels.sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
  { ttl: 3_600_000, fallback: [] }
);

const openAICompatibleProvider: AIProvider = {
  providerType: 'openai-compatible',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await prepareRuntime(req.userId, req.modelName);

    const completion = await client.chat.completions.create(
      {
        model: req.modelName,
        messages: buildChatMessages(req),
        stream: false,
      },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI-compatible API.');
    return { text };
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const { client } = await prepareRuntime(req.userId, req.modelName);
    yield* streamOAICompatAgentTurn(client, req);
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await prepareRuntime(req.userId, req.modelName);

    const stream = await client.chat.completions.create(
      {
        model: req.modelName,
        messages: buildChatMessages(req),
        stream: true,
      },
      { signal: req.signal }
    );

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield { type: 'text', text: delta, done: false };
      }
    }

    yield { type: 'text', text: '', done: true };
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!isImageModelId(req.modelName)) {
      throw new Error(`Image generation is not supported by model "${req.modelName}".`);
    }

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
      throw new Error('openai-compatible healthcheck requires an API key.');
    }
    if (!req.baseUrl?.trim()) {
      throw new Error('openai-compatible healthcheck requires a baseUrl.');
    }

    const baseUrl = req.baseUrl.trim();
    await validateBaseUrl(baseUrl);
    const client = createCompatibleClient(req.apiKey.trim(), baseUrl, {
      timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
      maxRetries: 0,
    });
    await withAbortTimeout(
      (signal) => client.models.list({ signal }),
      `OpenAI-compatible healthcheck timed out for ${baseUrl}.`,
      PROVIDER_PROBE_TIMEOUT_MS,
      () =>
        recordProviderProbeTimeout({
          provider: 'openai-compatible',
          operation: 'healthcheck',
          message: `OpenAI-compatible healthcheck timed out for ${baseUrl}.`,
        })
    );
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await secretService.validateApiKey(apiKey);
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { apiKey } = await resolveClientConfig(userId, modelName);
    return apiKey;
  },
};

// Self-register on import
registerProvider(openAICompatibleProvider);

export { openAICompatibleProvider };
