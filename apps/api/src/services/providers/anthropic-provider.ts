/**
 * AIProvider adapter for Anthropic Claude models.
 * Uses the @anthropic-ai/sdk for text generation and streaming.
 * Image generation is not supported by Anthropic.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createProviderSecretService } from './secret-service';
import { withModelCache } from './model-cache';
import { registerProvider } from './registry';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingTextChunk,
  ImageGenerationResult,
  ModelInfo,
} from './types';

/** Hardcoded fallback when client.models.list() is unavailable or returns empty. */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    modelId: 'claude-sonnet-4-5-20250514',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    capabilities: { text: true, image: false, streaming: true },
  },
  {
    modelId: 'claude-haiku-3-5-20241022',
    displayName: 'Claude Haiku 3.5',
    provider: 'anthropic',
    capabilities: { text: true, image: false, streaming: true },
  },
];

const secretService = createProviderSecretService({
  provider: 'anthropic',
  tomlSection: 'anthropic_api_keys',
  envVarPrefix: 'ANTHROPIC_API_KEY',
  validateFn: async (apiKey) => {
    const client = new Anthropic({ apiKey });
    // Light validation: list first page of models
    try {
      await client.models.list({ limit: 1 });
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 403) {
        throw new Error('Anthropic rejected the API key. Verify that it is valid and enabled.');
      }
      throw new Error(
        `Anthropic API validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  },
});

function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    const apiKey = await secretService.resolveApiKey(userId);
    const client = createClient(apiKey);

    try {
      const models: ModelInfo[] = [];

      for await (const model of client.models.list({ limit: 100 })) {
        models.push({
          modelId: model.id,
          displayName: model.display_name || model.id,
          provider: 'anthropic',
          capabilities: { text: true, image: false, streaming: true },
        });
      }

      return models.length > 0
        ? models.sort((a, b) => a.displayName.localeCompare(b.displayName))
        : FALLBACK_MODELS;
    } catch (err) {
      console.warn('[anthropic] Failed to list models dynamically, using fallback:', err);
      return FALLBACK_MODELS;
    }
  },
  { ttl: 3_600_000, fallback: FALLBACK_MODELS }
);

function buildMessages(req: TextGenerationRequest): Anthropic.MessageCreateParams['messages'] {
  return [
    ...req.history.map(
      (msg): Anthropic.MessageParam => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.text,
      })
    ),
    { role: 'user' as const, content: req.prompt },
  ];
}

const anthropicProvider: AIProvider = {
  providerType: 'anthropic',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const apiKey = await secretService.resolveApiKey(req.userId, req.modelName);
    const client = createClient(apiKey);

    const response = await client.messages.create(
      {
        model: req.modelName,
        max_tokens: 8192,
        ...(req.systemPrompt?.trim() ? { system: req.systemPrompt } : {}),
        messages: buildMessages(req),
      },
      { signal: req.signal }
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (!text) throw new Error('No text returned from Anthropic API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingTextChunk> {
    const apiKey = await secretService.resolveApiKey(req.userId, req.modelName);
    const client = createClient(apiKey);

    const stream = client.messages.stream(
      {
        model: req.modelName,
        max_tokens: 8192,
        ...(req.systemPrompt?.trim() ? { system: req.systemPrompt } : {}),
        messages: buildMessages(req),
      },
      { signal: req.signal }
    );

    for await (const event of stream) {
      if (req.signal?.aborted) break;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { text: event.delta.text, done: false };
      }
    }

    yield { text: '', done: true };
  },

  async generateImage(): Promise<ImageGenerationResult> {
    throw new Error('Anthropic does not support image generation.');
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await secretService.validateApiKey(apiKey);
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    return secretService.resolveApiKey(userId, modelName);
  },
};

// Self-register on import
registerProvider(anthropicProvider);

export { anthropicProvider };
