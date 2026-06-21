/**
 * AIProvider adapter for OpenAI-compatible APIs.
 * Supports DeepSeek, OpenRouter, and any other OpenAI-compatible endpoint via baseURL.
 * The baseURL is stored per-connector in secret_metadata.baseUrl.
 */

import { validateBaseUrl } from '../core/base-url-policy';
import { isImageModelId, isReasoningModel } from '../core/capability-detector';
import { withModelCache } from '../core/model-cache';
import { PROVIDER_PROBE_TIMEOUT_MS, withAbortTimeout } from '../core/probe-timeout';
import { createProviderLifecycle } from '../core/provider-lifecycle';
import { recordProviderProbeTimeout } from '../core/provider-observability';
import { createProviderSecretService } from '../core/secret-service';
import { generateChatCompletionText, streamChatCompletionText } from '../openai/chat-completions';
import {
  createOpenAIClientRuntimeLoader,
  createOpenAIProviderLifecycleHandlers,
  type OpenAIClientRuntime,
} from '../openai/client-runtime';
import { generateImageWithOpenAIClient } from '../openai/image-generation';
import { extractReasoningChunks } from '../openai/normalizers';
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

type PreparedCompatibleRuntime = OpenAIClientRuntime<{ apiKey: string; baseUrl: string }>;

const loadPreparedRuntime = createOpenAIClientRuntimeLoader(
  resolveClientConfig,
  ({ apiKey, baseUrl }) => createCompatibleClient(apiKey, baseUrl)
);

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

const lifecycle = createProviderLifecycle<PreparedCompatibleRuntime>({
  provider: 'openai-compatible',
  loadPreparedRuntime,
  invalidateCachedModels: listModelsWithCache.invalidate,
  syncConfigFileConnectors: secretService.syncConfigFileConnectors,
});

const openAICompatibleProvider: AIProvider = {
  providerType: 'openai-compatible',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    return generateChatCompletionText(client, req, 'No text returned from OpenAI-compatible API.');
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    yield* streamOAICompatAgentTurn(client, req);
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    yield* streamChatCompletionText(client, req);
  },

  generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return generateImageWithOpenAIClient(lifecycle.prepareRuntime, req, {
      validateModelBeforeRuntime: true,
    });
  },

  listModels: listModelsWithCache,
  ...createOpenAIProviderLifecycleHandlers(lifecycle),

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

export { openAICompatibleProvider };
