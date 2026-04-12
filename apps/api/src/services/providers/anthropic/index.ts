/**
 * AIProvider adapter for Anthropic Claude models.
 * Uses the @anthropic-ai/sdk for text generation and streaming.
 * Image generation is not supported by Anthropic.
 */

import Anthropic from '@anthropic-ai/sdk';
import { registerProvider } from '../core/provider-registry';
import { withModelCache } from '../core/model-cache';
import { createProviderSecretService } from '../core/secret-service';
import { isReasoningModel } from '../core/capability-detector';
import { getModelContextLimit } from '../core/context-policy';
import { narrowDelta, narrowSdkError } from './normalizers';
import { streamAnthropicAgentTurn } from './stream';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingChunk,
  ImageGenerationResult,
  ModelInfo,
  AgentTurnRequest,
  AgentEvent,
} from '../types';

/**
 * Canonical fallback model IDs confirmed against the installed @anthropic-ai/sdk types.
 * Update here when Anthropic releases newer stable snapshots.
 */
const ANTHROPIC_FALLBACK_MODELS = {
  primaryText: 'claude-sonnet-4-5-20250929',
  fastText: 'claude-haiku-4-5-20251001',
} as const;

const FALLBACK_MODELS: ModelInfo[] = [
  {
    modelId: ANTHROPIC_FALLBACK_MODELS.primaryText,
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    capabilities: {
      text: true,
      image: false,
      streaming: true,
      reasoning: true,
      tools: true,
      statefulContinuation: false,
      promptCaching: true,
      parallelToolCalls: false,
      reasoningWithTools: true,
    },
  },
  {
    modelId: ANTHROPIC_FALLBACK_MODELS.fastText,
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    capabilities: {
      text: true,
      image: false,
      streaming: true,
      reasoning: false,
      tools: true,
      statefulContinuation: false,
      promptCaching: true,
      parallelToolCalls: false,
      reasoningWithTools: false,
    },
  },
];

const secretService = createProviderSecretService({
  provider: 'anthropic',
  tomlSection: 'anthropic_api_keys',
  envVarPrefix: 'ANTHROPIC_API_KEY',
  validateFn: async (apiKey) => {
    const client = new Anthropic({ apiKey });
    try {
      await client.models.list({ limit: 1 });
    } catch (err: unknown) {
      const sdkErr = narrowSdkError(err);
      if (sdkErr.status === 401 || sdkErr.status === 403) {
        throw new Error('Anthropic rejected the API key. Verify that it is valid and enabled.');
      }
      throw new Error(`Anthropic API validation failed: ${sdkErr.message}`);
    }
  },
});

function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

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
          inputTokenLimit: getModelContextLimit(model.id),
          capabilities: {
            text: true,
            image: false,
            streaming: true,
            reasoning: isReasoningModel(model.id),
            tools: true,
            statefulContinuation: false,
            promptCaching: true,
            parallelToolCalls: false,
            reasoningWithTools: isReasoningModel(model.id),
          },
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

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const apiKey = await secretService.resolveApiKey(req.userId, req.modelName);
    const client = createClient(apiKey);
    yield* streamAnthropicAgentTurn(client, req);
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const apiKey = await secretService.resolveApiKey(req.userId, req.modelName);
    const client = createClient(apiKey);

    const thinkingEnabled = req.generationConfig?.thinkingEnabled ?? false;
    const effort = req.generationConfig?.reasoningEffort ?? 'medium';
    const budgetMap = { low: 1024, medium: 2048, high: 8192 } as const;

    const params: Record<string, unknown> = {
      model: req.modelName,
      max_tokens: thinkingEnabled ? 16000 : 8192,
      ...(req.systemPrompt?.trim() ? { system: req.systemPrompt } : {}),
      messages: buildMessages(req),
    };

    if (thinkingEnabled) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: budgetMap[effort] ?? 2048,
      };
    }

    const stream = client.messages.stream(params as unknown as Anthropic.MessageCreateParams, {
      signal: req.signal,
    });

    for await (const event of stream) {
      if (req.signal?.aborted) break;

      if (event.type === 'content_block_delta') {
        const nd = narrowDelta(event.delta);
        if (nd.kind === 'thinking') {
          yield { type: 'thinking', text: nd.thinking, done: false };
        } else if (nd.kind === 'text') {
          yield { type: 'text', text: nd.text, done: false };
        }
      }
    }

    yield { type: 'text', text: '', done: true };
  },

  generateImage(): Promise<ImageGenerationResult> {
    return Promise.reject(new Error('Anthropic does not support image generation.'));
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
    return secretService.resolveApiKey(userId, modelName);
  },
};

// Self-register on import
registerProvider(anthropicProvider);

export { anthropicProvider };
