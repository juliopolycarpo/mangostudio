/**
 * AIProvider adapter for OpenAI-compatible APIs.
 * Supports DeepSeek, OpenRouter, and any other OpenAI-compatible endpoint via baseURL.
 * The baseURL is stored per-connector in secret_metadata.baseUrl.
 */

import { registerProvider } from '../core/provider-registry';
import { withModelCache } from '../core/model-cache';
import { createProviderSecretService } from '../core/secret-service';
import { isImageModelId, isReasoningModel } from '../core/capability-detector';
import { buildChatMessages } from '../openai/message-mapper';
import { generateOpenAIImage } from '../openai/image-generation';
import { extractReasoningChunks } from '../openai/normalizers';
import { createCompatibleClient } from './client';
import { classifyEndpoint } from './endpoint-classifier';
import { streamOAICompatAgentTurn } from './chat-completions-stream';
import { resolveCompatibleClientConfig } from './resolve-client-config';
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

// Re-export for consumers
export { extractReasoningChunks, classifyEndpoint };

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
        const client = createCompatibleClient(apiKey, baseUrl);
        const endpoint = classifyEndpoint(baseUrl);
        // OpenRouter and DeepSeek advertise Chat Completions response_format JSON
        // Schema support. Generic endpoints are unknown territory — report false
        // so callers make no assumptions until verified.
        const supportsStructuredOutput = endpoint === 'openrouter' || endpoint === 'deepseek';

        for await (const model of await client.models.list()) {
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
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createCompatibleClient(apiKey, baseUrl);

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
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createCompatibleClient(apiKey, baseUrl);
    yield* streamOAICompatAgentTurn(client, req);
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createCompatibleClient(apiKey, baseUrl);

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

    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createCompatibleClient(apiKey, baseUrl);

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
