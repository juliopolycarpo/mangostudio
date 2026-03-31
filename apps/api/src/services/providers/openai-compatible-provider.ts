/**
 * AIProvider adapter for OpenAI-compatible APIs.
 * Supports OpenAI, DeepSeek, and OpenRouter via customizable baseURL.
 * The baseURL is stored per-connector in secret_metadata.baseUrl.
 */

import OpenAI from 'openai';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createProviderSecretService } from './secret-service';
import { withModelCache } from './model-cache';
import { registerProvider } from './registry';
import { getConfig } from '../../lib/config';
import { isImageModelId } from '@mangostudio/shared/utils/model-detection';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingTextChunk,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
} from './types';

const secretService = createProviderSecretService({
  provider: 'openai-compatible',
  tomlSection: 'openai_compatible_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  shouldSyncConfigEntry: ({ existing }) => Boolean(existing?.baseUrl?.trim()),
  validateFn: async (_apiKey, _fetchImpl) => {
    // validateFn is not called for openai-compatible without a baseUrl.
    // Key validation for this provider always goes through validateProviderKey()
    // in the connector route, which requires a baseUrl.
    throw new Error('Cannot validate an openai-compatible key without a baseUrl.');
  },
});

/**
 * Resolves the API key and base URL for the connector that has the requested model enabled.
 * Falls back to the first configured connector when no model is specified.
 */
async function resolveClientConfig(
  userId: string,
  modelName?: string
): Promise<{ apiKey: string; baseUrl: string }> {
  await secretService.syncConfigFileConnectors(userId);
  const rows = await secretService.listMeta('openai-compatible', userId);

  for (const row of rows) {
    if (!row.configured) continue;
    if (!row.baseUrl) continue; // skip connectors without a custom endpoint
    const enabled: string[] = JSON.parse(row.enabledModels);
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

function createClient(apiKey: string, baseUrl: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('openai-compatible', userId);

    // Group connectors by base URL to avoid duplicate API calls
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
        const client = createClient(apiKey, baseUrl);

        for await (const model of await client.models.list()) {
          if (
            model.id.includes('embedding') ||
            model.id.includes('tts') ||
            model.id.includes('whisper') ||
            model.id.includes('moderation')
          ) {
            continue;
          }

          allModels.push({
            modelId: model.id,
            displayName: model.id,
            provider: 'openai-compatible',
            capabilities: {
              text: !isImageModelId(model.id),
              image: isImageModelId(model.id),
              streaming: !isImageModelId(model.id),
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

function buildMessages(req: TextGenerationRequest): OpenAI.ChatCompletionMessageParam[] {
  return [
    ...(req.systemPrompt?.trim() ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
    ...req.history.map(
      (msg): OpenAI.ChatCompletionMessageParam => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.text,
      })
    ),
    { role: 'user' as const, content: req.prompt },
  ];
}

const openAICompatibleProvider: AIProvider = {
  providerType: 'openai-compatible',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey, baseUrl);

    const completion = await client.chat.completions.create(
      {
        model: req.modelName,
        messages: buildMessages(req),
        stream: false,
      },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI-compatible API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingTextChunk> {
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey, baseUrl);

    const stream = await client.chat.completions.create(
      {
        model: req.modelName,
        messages: buildMessages(req),
        stream: true,
      },
      { signal: req.signal }
    );

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield { text: delta, done: false };
      }
    }

    yield { text: '', done: true };
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!isImageModelId(req.modelName)) {
      throw new Error(`Image generation is not supported by model "${req.modelName}".`);
    }

    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey, baseUrl);

    const isGptImage = req.modelName.startsWith('gpt-image');

    // Build model-appropriate params: gpt-image doesn't support `response_format` or `n`
    const params: OpenAI.Images.ImageGenerateParamsNonStreaming = isGptImage
      ? { model: req.modelName, prompt: req.prompt, size: '1024x1024' }
      : {
          model: req.modelName,
          prompt: req.prompt,
          size: '1024x1024',
          n: 1,
          response_format: 'url',
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
