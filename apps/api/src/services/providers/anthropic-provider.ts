/**
 * AIProvider adapter for Anthropic Claude models.
 * Uses the @anthropic-ai/sdk for text generation and streaming.
 * Image generation is not supported by Anthropic.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createProviderSecretService } from './secret-service';
import { withModelCache } from './model-cache';
import { registerProvider } from './registry';
import { buildCachedAnthropicRequest } from './anthropic-cache-builder';
import { isReasoningModel } from '@mangostudio/shared/utils/model-detection';
import {
  computeSystemPromptHash,
  computeToolsetHash,
} from './continuation';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingChunk,
  ImageGenerationResult,
  ModelInfo,
  AgentTurnRequest,
  AgentEvent,
} from './types';

/** Hardcoded fallback when client.models.list() is unavailable or returns empty. */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    modelId: 'claude-sonnet-4-5-20250514',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    capabilities: {
      text: true, image: false, streaming: true, reasoning: true,
      tools: true, statefulContinuation: false, promptCaching: true,
      parallelToolCalls: false, reasoningWithTools: true,
    },
  },
  {
    modelId: 'claude-haiku-3-5-20241022',
    displayName: 'Claude Haiku 3.5',
    provider: 'anthropic',
    capabilities: {
      text: true, image: false, streaming: true, reasoning: false,
      tools: true, statefulContinuation: false, promptCaching: true,
      parallelToolCalls: false, reasoningWithTools: false,
    },
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

// ---------------------------------------------------------------------------
// Anthropic stateless agentic tool loop
// ---------------------------------------------------------------------------

/** Opaque loop-state stored in providerState during the tool-call loop. */
interface AnthropicLoopState {
  provider: 'anthropic';
  /** Accumulated messages (assistant + user tool_result) from within the agent turn. */
  loopMessages: Array<Anthropic.MessageParam>;
}

function parseAnthropicLoopState(
  providerState: string | null | undefined
): AnthropicLoopState | null {
  if (!providerState) return null;
  try {
    const parsed = JSON.parse(providerState) as Record<string, unknown>;
    if (parsed.provider === 'anthropic' && Array.isArray(parsed.loopMessages)) {
      return parsed as unknown as AnthropicLoopState;
    }
  } catch {
    // Ignore malformed state
  }
  return null;
}

/**
 * Streams a single agentic turn for Anthropic.
 * Stateless — DB history is replayed on each turn; in-loop accumulation via providerState.
 */
async function* streamAnthropicAgentTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
  const apiKey = await secretService.resolveApiKey(req.userId, req.modelName);
  const client = createClient(apiKey);

  const loopState = parseAnthropicLoopState(req.providerState);
  const thinkingEnabled = req.generationConfig?.thinkingEnabled ?? false;
  const effort = req.generationConfig?.reasoningEffort ?? 'medium';
  const budgetMap = { low: 1024, medium: 2048, high: 8192 } as const;

  // Build messages: DB history + accumulated loop messages + current input
  const messages: Anthropic.MessageParam[] = [
    ...req.history.map(
      (turn): Anthropic.MessageParam => ({
        role: turn.role === 'ai' ? 'assistant' : 'user',
        content: turn.text,
      })
    ),
    ...(loopState?.loopMessages ?? []),
  ];

  // Add current input: tool results or user prompt
  if (req.toolResults && req.toolResults.length > 0) {
    messages.push({
      role: 'user',
      content: req.toolResults.map((tr) => ({
        type: 'tool_result' as const,
        tool_use_id: tr.callId,
        content: tr.result,
        is_error: tr.isError ?? false,
      })),
    });
  } else if (req.prompt) {
    messages.push({ role: 'user', content: req.prompt });
  }

  // Build request with prompt caching (cache_control: ephemeral on system + last tool)
  const cachedReq = buildCachedAnthropicRequest({
    systemPrompt: req.systemPrompt ?? '',
    toolDefinitions: req.toolDefinitions ?? [],
    messages,
    thinkingConfig: thinkingEnabled
      ? { type: 'enabled', budget_tokens: budgetMap[effort] ?? 2048 }
      : undefined,
  });

  const params = {
    model: req.modelName,
    ...cachedReq,
  };

  try {
    const stream = client.messages.stream(params as unknown as Anthropic.MessageCreateParams, {
      signal: req.signal,
    });

    // Collect the full content blocks for loop-state accumulation
    const assistantContent: Anthropic.ContentBlock[] = [];
    // Track tool_use blocks by content block index
    const blockByIndex = new Map<number, { callId: string; name: string; inputStr: string }>();

    for await (const event of stream) {
      if (req.signal?.aborted) break;

      if (event.type === 'content_block_start') {
        const block = event.content_block as unknown as Record<string, any>;
        if (block.type === 'tool_use') {
          const callId: string = block.id ?? `tu_${Date.now()}_${event.index}`;
          const name: string = block.name ?? '';
          blockByIndex.set(event.index, { callId, name, inputStr: '' });
          yield { type: 'tool_call_started', callId, name };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta as unknown as Record<string, unknown>;
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'reasoning_delta', text: delta.thinking };
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'assistant_text_delta', text: delta.text };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const block = blockByIndex.get(event.index);
          if (block) {
            block.inputStr += delta.partial_json;
            yield {
              type: 'tool_call_arguments_delta',
              callId: block.callId,
              delta: delta.partial_json,
            };
          }
        }
      } else if (event.type === 'content_block_stop') {
        const block = blockByIndex.get(event.index);
        if (block) {
          yield {
            type: 'tool_call_completed',
            callId: block.callId,
            name: block.name,
            arguments: block.inputStr,
          };
          blockByIndex.delete(event.index);
        }
      } else if (event.type === 'message_stop') {
        // Collect the final message for loop accumulation
        const finalMsg = await stream.finalMessage();
        for (const block of finalMsg.content) {
          assistantContent.push(block);
        }
      }
    }

    // Log prompt cache usage for monitoring
    try {
      const finalMsg = await stream.finalMessage();
      const usage = finalMsg.usage as Record<string, any>;
      const cached = usage.cache_read_input_tokens ?? 0;
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;
      const total = usage.input_tokens ?? 0;
      if (cached > 0 || cacheCreation > 0) {
        console.log(
          `[prefix-cache][anthropic] read=${cached} creation=${cacheCreation} total=${total} tokens` +
            (total > 0 ? ` (${Math.round((cached / total) * 100)}% cache hit)` : '')
        );
      }
    } catch {
      // Non-critical — don't block the response for cache logging
    }

    // Build updated loop messages
    const newLoopMessages: Anthropic.MessageParam[] = [
      ...(loopState?.loopMessages ?? []),
      ...(req.toolResults && req.toolResults.length > 0
        ? [
            {
              role: 'user' as const,
              content: req.toolResults.map((tr) => ({
                type: 'tool_result' as const,
                tool_use_id: tr.callId,
                content: tr.result,
                is_error: tr.isError ?? false,
              })),
            },
          ]
        : req.prompt
          ? [{ role: 'user' as const, content: req.prompt }]
          : []),
      ...(assistantContent.length > 0
        ? [{ role: 'assistant' as const, content: assistantContent }]
        : []),
    ];

    // Emit an envelope-compatible state that also carries the loop messages.
    // parseContinuationEnvelope reads the envelope fields for route-level validation;
    // parseAnthropicLoopState reads provider + loopMessages for the in-turn loop.
    const envelopeWithLoop = {
      schemaVersion: 1 as const,
      provider: 'anthropic' as const,
      mode: 'stateless-loop' as const,
      modelName: req.modelName,
      systemPromptHash: computeSystemPromptHash(req.systemPrompt),
      toolsetHash: computeToolsetHash(req.toolDefinitions ?? []),
      loopMessages: newLoopMessages,
    };

    yield { type: 'turn_completed', providerState: JSON.stringify(envelopeWithLoop) };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'Anthropic request failed',
    };
  }
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

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    yield* streamAnthropicAgentTurn(req);
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
        // The SDK types don't include thinking_delta yet — use a safe cast
        const delta = event.delta as unknown as Record<string, unknown>;
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'thinking', text: delta.thinking, done: false };
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', text: delta.text, done: false };
        }
      }
    }

    yield { type: 'text', text: '', done: true };
  },

  async generateImage(): Promise<ImageGenerationResult> {
    throw new Error('Anthropic does not support image generation.');
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
