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
import { isImageModelId, isReasoningModel } from '@mangostudio/shared/utils/model-detection';
import { computeSystemPromptHash, computeToolsetHash } from './continuation';
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
  ToolDefinition,
} from './types';
import { buildChatCompletionsReplay } from './replay-builder';
import { parseStringArray } from '../../utils/json';
import { extractReasoningChunks } from './openai-normalizers';

const secretService = createProviderSecretService({
  provider: 'openai-compatible',
  tomlSection: 'openai_compatible_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  shouldSyncConfigEntry: ({ existing }) => Boolean(existing?.baseUrl?.trim()),
  validateFn: (_apiKey, _fetchImpl) => {
    // validateFn is not called for openai-compatible without a baseUrl.
    // Key validation for this provider always goes through validateProviderKey()
    // in the connector route, which requires a baseUrl.
    return Promise.reject(new Error('Cannot validate an openai-compatible key without a baseUrl.'));
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

function createClient(apiKey: string, baseUrl: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}

/**
 * Classifies the endpoint type from its base URL.
 * Used to apply endpoint-specific reasoning extraction logic and capability flags.
 */
export function classifyEndpoint(baseUrl: string): 'deepseek' | 'openrouter' | 'generic' {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('deepseek.com')) return 'deepseek';
  if (lower.includes('openrouter.ai')) return 'openrouter';
  return 'generic';
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
              // Non-image models on openai-compatible endpoints accept parallel tool calls
              // in the streaming loop (multiple tool_calls in one assistant message).
              parallelToolCalls: !isImage,
              // Reasoning models that are not image-only support reasoning alongside tools.
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

// ---------------------------------------------------------------------------
// OpenAI-compatible stateless agentic tool loop
// ---------------------------------------------------------------------------

/** Opaque loop-state stored in providerState during the tool-call loop. */
interface OAICompatLoopState {
  provider: 'openai-compatible';
  /** Accumulated messages within the current agent turn. */
  loopMessages: Array<OpenAI.ChatCompletionMessageParam>;
}

function parseOAICompatLoopState(
  providerState: string | null | undefined
): OAICompatLoopState | null {
  if (!providerState) return null;
  try {
    const parsed = JSON.parse(providerState) as Record<string, unknown>;
    if (parsed.provider === 'openai-compatible' && Array.isArray(parsed.loopMessages)) {
      return parsed as unknown as OAICompatLoopState;
    }
  } catch {
    // Ignore malformed state
  }
  return null;
}

function toolDefsToOAIChat(defs: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return defs.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  }));
}

// Re-export for backward compatibility with test imports
export { extractReasoningChunks };

/**
 * Streams a single agentic turn for OpenAI-compatible endpoints.
 * Stateless — history replayed from DB. In-loop accumulation via providerState.
 * DeepSeek-r1: reasoning_content is automatically included in tool call loop
 * since we replay the full assistant message including any reasoning_content field.
 */
async function* streamOAICompatAgentTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
  const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
  const client = createClient(apiKey, baseUrl);

  const loopState = parseOAICompatLoopState(req.providerState);
  const tools =
    req.toolDefinitions && req.toolDefinitions.length > 0
      ? toolDefsToOAIChat(req.toolDefinitions)
      : undefined;

  // Build messages: system + structured DB history + accumulated loop messages + current input
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(req.systemPrompt?.trim() ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
    ...buildChatCompletionsReplay(req.history),
    ...(loopState?.loopMessages ?? []),
  ];

  // Add current input: tool results or user prompt
  if (req.toolResults && req.toolResults.length > 0) {
    for (const tr of req.toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.callId,
        content: tr.result,
      });
    }
  } else if (req.prompt) {
    messages.push({ role: 'user', content: req.prompt });
  }

  try {
    const stream = await client.chat.completions.create(
      {
        model: req.modelName,
        messages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
        stream: true,
      },
      { signal: req.signal }
    );

    // Accumulate the full assistant message for loop-state
    let assistantText = '';
    let assistantReasoning = '';
    const pendingToolCalls = new Map<number, { callId: string; name: string; argsStr: string }>();

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta as unknown as Record<string, unknown>;

      // Multi-field reasoning extraction — see extractReasoningChunks for details.
      // Reasoning is accumulated intra-turn only; cross-turn reset is enforced below.
      for (const reasoningChunk of extractReasoningChunks(delta)) {
        assistantReasoning += reasoningChunk;
        yield { type: 'reasoning_delta', text: reasoningChunk };
      }

      if (typeof delta.content === 'string' && delta.content) {
        assistantText += delta.content;
        yield { type: 'assistant_text_delta', text: delta.content };
      }

      // Tool call streaming
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(toolCalls)) {
        for (const tcDelta of toolCalls) {
          const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
          const fn = tcDelta.function as Record<string, unknown> | undefined;

          if (typeof tcDelta.id === 'string') {
            // New tool call
            const callId = tcDelta.id;
            const name = typeof fn?.name === 'string' ? fn.name : '';
            const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
            pendingToolCalls.set(idx, { callId, name, argsStr: args });
            yield {
              type: 'tool_call_started',
              callId,
              name: name || undefined,
            };
          } else {
            const tc = pendingToolCalls.get(idx);
            if (tc) {
              const argsDelta = typeof fn?.arguments === 'string' ? fn.arguments : '';
              tc.argsStr += argsDelta;
              if (argsDelta) {
                yield { type: 'tool_call_arguments_delta', callId: tc.callId, delta: argsDelta };
              }
            }
          }
        }
      }

      if (choice.finish_reason) {
        // Finalize all pending tool calls
        for (const tc of pendingToolCalls.values()) {
          yield {
            type: 'tool_call_completed',
            callId: tc.callId,
            name: tc.name,
            arguments: tc.argsStr,
          };
        }
      }
    }

    // Build the assistant message for loop-state accumulation.
    // reasoning_content is only included on intra-turn loop messages (when tool calls are
    // still pending) to satisfy DeepSeek's requirement that reasoning context is available
    // during continuation. It is intentionally OMITTED from the final message (no pending
    // tool calls) so reasoning is never persisted cross-turn — defense-in-depth beyond the
    // route-level turn boundary reset in PR 001.
    // See: https://api-docs.deepseek.com/guides/thinking_mode
    const assistantMsg: OpenAI.ChatCompletionMessageParam =
      pendingToolCalls.size > 0
        ? {
            role: 'assistant',
            content: assistantText || null,
            tool_calls: Array.from(pendingToolCalls.values()).map((tc) => ({
              id: tc.callId,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.argsStr },
            })),
            // Intra-turn only: reasoning passback for DeepSeek/OpenRouter tool continuations.
            ...(assistantReasoning ? { reasoning_content: assistantReasoning } : {}),
          }
        : { role: 'assistant', content: assistantText };

    const newLoopMessages: OpenAI.ChatCompletionMessageParam[] = [
      ...(loopState?.loopMessages ?? []),
      ...(req.toolResults && req.toolResults.length > 0
        ? req.toolResults.map(
            (tr): OpenAI.ChatCompletionMessageParam => ({
              role: 'tool',
              tool_call_id: tr.callId,
              content: tr.result,
            })
          )
        : req.prompt
          ? [{ role: 'user' as const, content: req.prompt }]
          : []),
      assistantMsg,
    ];

    // Emit an envelope-compatible state that also carries the loop messages.
    const envelopeWithLoop = {
      schemaVersion: 1 as const,
      provider: 'openai-compatible' as const,
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
      error: err instanceof Error ? err.message : 'OpenAI-compatible request failed',
    };
  }
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

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    yield* streamOAICompatAgentTurn(req);
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
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
