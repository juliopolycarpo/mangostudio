/**
 * AIProvider adapter for Anthropic Claude models.
 * Uses the @anthropic-ai/sdk for text generation and streaming.
 * Image generation is not supported by Anthropic.
 */

import Anthropic from '@anthropic-ai/sdk';
import { appendAttachmentFallbackNotes } from '../core/attachment-content';
import { isReasoningModel } from '../core/capability-detector';
import { getModelContextLimit } from '../core/context-policy';
import { withModelCache } from '../core/model-cache';
import { withAbortTimeout } from '../core/probe-timeout';
import {
  recordProviderCacheHit,
  recordProviderCacheMiss,
  recordProviderProbeTimeout,
} from '../core/provider-observability';
import { registerProvider } from '../core/provider-registry';
import { createReadinessCache, createReadinessCacheKey } from '../core/readiness-cache';
import { createProviderSecretService } from '../core/secret-service';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ImageGenerationResult,
  ModelInfo,
  ProviderHealthcheckRequest,
  ProviderWarmupRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { createAnthropicClient } from './client';
import { narrowDelta, narrowSdkError, toMessageCreateParams } from './normalizers';
import { streamAnthropicAgentTurn } from './stream';

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
      structuredOutput: false,
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
      structuredOutput: false,
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
      await withAbortTimeout(
        (signal) => client.models.list({ limit: 1 }, { signal }),
        'Anthropic API validation timed out.',
        undefined,
        () =>
          recordProviderProbeTimeout({
            provider: 'anthropic',
            operation: 'healthcheck',
            message: 'Anthropic API validation timed out.',
          })
      );
    } catch (err: unknown) {
      const sdkErr = narrowSdkError(err);
      if (sdkErr.status === 401 || sdkErr.status === 403) {
        throw new Error('Anthropic rejected the API key. Verify that it is valid and enabled.', {
          cause: err,
        });
      }
      throw new Error(`Anthropic API validation failed: ${sdkErr.message}`, { cause: err });
    }
  },
});

function buildMessages(req: TextGenerationRequest): Anthropic.MessageCreateParams['messages'] {
  const prompt = appendAttachmentFallbackNotes(req.prompt, req.attachments, req.modelCapabilities);

  return [
    ...req.history.map(
      (msg): Anthropic.MessageParam => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.text,
      })
    ),
    { role: 'user' as const, content: prompt },
  ];
}

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    const apiKey = await secretService.resolveApiKey(userId);
    const client = createAnthropicClient(apiKey);

    try {
      const models: ModelInfo[] = [];

      const modelPage = await withAbortTimeout(
        (signal) => client.models.list({ limit: 100 }, { signal }),
        'Anthropic model listing timed out.',
        undefined,
        () =>
          recordProviderProbeTimeout({
            provider: 'anthropic',
            operation: 'model-list',
            message: 'Anthropic model listing timed out.',
          })
      );

      for await (const model of modelPage) {
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
            structuredOutput: false,
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

interface PreparedAnthropicRuntime {
  readonly apiKey: string;
  readonly client: ReturnType<typeof createAnthropicClient>;
}

const preparedRuntimeCache = createReadinessCache<PreparedAnthropicRuntime>({
  onHit: () => recordProviderCacheHit('anthropic', 'prepared-runtime'),
  onMiss: () => recordProviderCacheMiss('anthropic', 'prepared-runtime'),
});

async function loadPreparedRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedAnthropicRuntime> {
  const apiKey = await secretService.resolveApiKey(userId, modelName);
  return {
    apiKey,
    client: createAnthropicClient(apiKey),
  };
}

async function prepareRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedAnthropicRuntime> {
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

const anthropicProvider: AIProvider = {
  providerType: 'anthropic',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await prepareRuntime(req.userId, req.modelName);

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
    const { client } = await prepareRuntime(req.userId, req.modelName);
    yield* streamAnthropicAgentTurn(client, req);
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await prepareRuntime(req.userId, req.modelName);

    const thinkingEnabled = req.generationConfig?.thinkingEnabled ?? false;
    const effort = req.generationConfig?.reasoningEffort ?? 'medium';
    const budgetMap: Record<string, number> = {
      low: 1024,
      medium: 2048,
      high: 8192,
      xhigh: 8192,
      max: 8192,
    };

    const params: Record<string, unknown> = {
      model: req.modelName,
      max_tokens: thinkingEnabled ? 16000 : 8192,
      ...(req.systemPrompt?.trim() ? { system: req.systemPrompt } : {}),
      messages: buildMessages(req),
    };

    if (thinkingEnabled) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: budgetMap[effort],
      };
    }

    const stream = client.messages.stream(toMessageCreateParams(params), {
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
      throw new Error('anthropic healthcheck requires an API key.');
    }

    await secretService.validateApiKey(req.apiKey.trim());
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
