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
import { extractReasoningChunks } from '../openai/normalizers';
import { createCompatibleClient } from './client';
import { classifyEndpoint } from './endpoint-classifier';
import { streamOAICompatAgentTurn } from './chat-completions-stream';
import { getConfig } from '../../../lib/config';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { parseStringArray } from '../../../utils/json';
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

  for (const row of rows) {
    if (!row.configured) continue;
    if (!row.baseUrl) continue;
    const enabled = parseStringArray(row.enabledModels);
    if (modelName && enabled.length > 0 && !enabled.includes(modelName)) continue;

    const apiKey = await secretService.resolveSecretValue(row);
    if (apiKey) {
      return { apiKey, baseUrl: row.baseUrl };
    }
  }

  throw new Error(
    'No openai-compatible connector with a valid baseUrl is configured for this model.'
  );
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

    const isGptImage = req.modelName.startsWith('gpt-image');

    const params = isGptImage
      ? { model: req.modelName, prompt: req.prompt, size: '1024x1024' as const }
      : {
          model: req.modelName,
          prompt: req.prompt,
          size: '1024x1024' as const,
          n: 1,
          response_format: 'url' as const,
        };

    const response = await client.images.generate(params);

    const uploadsDir = getConfig().uploads.dir;
    mkdirSync(uploadsDir, { recursive: true });

    const filename = `generated-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
    const outputPath = join(uploadsDir, filename);

    const data = response.data?.[0];

    if (data?.b64_json) {
      const imageBuffer = Buffer.from(data.b64_json, 'base64');
      await Bun.write(outputPath, imageBuffer);
    } else if (data?.url) {
      const imageResponse = await fetch(data.url);
      if (!imageResponse.ok) {
        throw new Error('Failed to download generated image from OpenAI CDN.');
      }
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      await Bun.write(outputPath, imageBuffer);
    } else {
      throw new Error(`No image data returned from OpenAI API for model "${req.modelName}".`);
    }

    return { imageUrl: `/uploads/${filename}` };
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
