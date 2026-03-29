/**
 * AIProvider adapter for OpenAI-compatible APIs.
 * Supports OpenAI, DeepSeek, and OpenRouter via customizable baseURL.
 * The baseURL is stored per-connector in secret_metadata.baseUrl.
 */

import OpenAI from 'openai';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createProviderSecretService } from './secret-service';
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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const secretService = createProviderSecretService({
  provider: 'openai-compatible',
  tomlSection: 'openai_compatible_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  validateFn: async (apiKey, fetchImpl) => {
    const response = await fetchImpl(`${DEFAULT_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`OpenAI API key validation failed (HTTP ${response.status}).`);
    }
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
    const enabled: string[] = JSON.parse(row.enabledModels);
    if (modelName && enabled.length > 0 && !enabled.includes(modelName)) continue;

    const apiKey = await secretService.resolveSecretValue(row);
    if (apiKey) {
      return { apiKey, baseUrl: row.baseUrl || DEFAULT_BASE_URL };
    }
  }

  throw new Error(
    'No OpenAI-compatible API key is configured or enabled. Check your Connectors in Settings.'
  );
}

function createClient(apiKey: string, baseUrl: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}

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

    const completion = await client.chat.completions.create({
      model: req.modelName,
      messages: buildMessages(req),
      stream: false,
    });

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI-compatible API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingTextChunk> {
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey, baseUrl);

    const stream = await client.chat.completions.create({
      model: req.modelName,
      messages: buildMessages(req),
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield { text: delta, done: false };
      }
    }

    yield { text: '', done: true };
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!req.modelName.startsWith('dall-e')) {
      throw new Error('Image generation is only supported by DALL-E models for this provider.');
    }

    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createClient(apiKey, baseUrl);

    const response = await client.images.generate({
      model: req.modelName,
      prompt: req.prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'url',
    });

    const remoteUrl = response.data?.[0]?.url;
    if (!remoteUrl) throw new Error('No image returned from OpenAI DALL-E.');

    // Download the image and save locally (OpenAI CDN URLs expire after ~1 hour)
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
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('openai-compatible', userId);

    // Group connectors by base URL to avoid duplicate API calls
    const seenBaseUrls = new Map<string, string>();

    for (const row of rows) {
      if (!row.configured) continue;
      const baseUrl = row.baseUrl || DEFAULT_BASE_URL;
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
          // Skip non-generation models
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
              text: !model.id.startsWith('dall-e'),
              image: model.id.startsWith('dall-e'),
              streaming: !model.id.startsWith('dall-e'),
            },
          });
        }
      } catch (err) {
        console.warn(`[openai-compatible] Failed to list models for ${baseUrl}:`, err);
      }
    }

    return allModels.sort((a, b) => a.displayName.localeCompare(b.displayName));
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
