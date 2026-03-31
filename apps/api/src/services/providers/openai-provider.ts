/**
 * AIProvider adapter for the official OpenAI API.
 * Always uses https://api.openai.com/v1. For custom endpoints use openai-compatible.
 */

import OpenAI from 'openai';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createProviderSecretService } from './secret-service';
import { withModelCache } from './model-cache';
import { registerProvider } from './registry';
import { getConfig } from '../../lib/config';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingTextChunk,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
} from './types';

const BASE_URL = 'https://api.openai.com/v1';

const secretService = createProviderSecretService({
  provider: 'openai',
  tomlSection: 'openai_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  validateFn: async (apiKey, fetchImpl) => {
    const response = await fetchImpl(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`OpenAI API key validation failed (HTTP ${response.status}).`);
    }
  },
});

async function resolveClientConfig(
  userId: string,
  modelName?: string
): Promise<{ apiKey: string; baseUrl: string }> {
  await secretService.syncConfigFileConnectors(userId);
  const rows = await secretService.listMeta('openai', userId);

  for (const row of rows) {
    if (!row.configured) continue;
    const enabled: string[] = JSON.parse(row.enabledModels);
    if (modelName && enabled.length > 0 && !enabled.includes(modelName)) continue;

    const apiKey = await secretService.resolveSecretValue(row);
    if (apiKey) {
      return { apiKey, baseUrl: BASE_URL };
    }
  }

  throw new Error(
    'No OpenAI API key is configured or enabled. Check your Connectors in Settings.'
  );
}

function createClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: BASE_URL });
}

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('openai', userId);

    let resolvedKey: string | null = null;
    for (const row of rows) {
      if (!row.configured) continue;
      const apiKey = await secretService.resolveSecretValue(row);
      if (apiKey) {
        resolvedKey = apiKey;
        break;
      }
    }

    if (!resolvedKey) return [];

    const allModels: ModelInfo[] = [];
    try {
      const client = createClient(resolvedKey);
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
          provider: 'openai',
          capabilities: {
            text: !model.id.startsWith('dall-e'),
            image: model.id.startsWith('dall-e'),
            streaming: !model.id.startsWith('dall-e'),
          },
        });
      }
    } catch (err) {
      console.warn(`[openai] Failed to list models:`, err);
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

const openAIProvider: AIProvider = {
  providerType: 'openai',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { apiKey } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey);

    const completion = await client.chat.completions.create(
      { model: req.modelName, messages: buildMessages(req), stream: false },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingTextChunk> {
    const { apiKey } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey);

    const stream = await client.chat.completions.create(
      { model: req.modelName, messages: buildMessages(req), stream: true },
      { signal: req.signal }
    );

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield { text: delta, done: false };
    }
    yield { text: '', done: true };
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!req.modelName.startsWith('dall-e')) {
      throw new Error('Image generation is only supported by DALL-E models.');
    }

    const { apiKey } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey);

    const response = await client.images.generate({
      model: req.modelName,
      prompt: req.prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'url',
    });

    const remoteUrl = response.data?.[0]?.url;
    if (!remoteUrl) throw new Error('No image returned from OpenAI DALL-E.');

    const uploadsDir = getConfig().uploads.dir;
    mkdirSync(uploadsDir, { recursive: true });

    const imageResponse = await fetch(remoteUrl);
    if (!imageResponse.ok) {
      throw new Error('Failed to download generated image from OpenAI CDN.');
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const filename = `generated-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
    await Bun.write(join(uploadsDir, filename), imageBuffer);

    return { imageUrl: `/uploads/${filename}` };
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
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
registerProvider(openAIProvider);

export { openAIProvider };
