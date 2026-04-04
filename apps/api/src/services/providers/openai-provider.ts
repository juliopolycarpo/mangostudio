/**
 * AIProvider adapter for the official OpenAI API.
 * Always uses https://api.openai.com/v1. For custom endpoints use openai-compatible.
 *
 * Validation and runtime both use the same OpenAI auth context (apiKey +
 * optional organizationId / projectId) so that project-scoped keys are never
 * rejected during connector setup.
 */

import OpenAI, { APIError as OpenAIAPIError } from 'openai';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createProviderSecretService } from './secret-service';
import { withModelCache } from './model-cache';
import { registerProvider } from './registry';
import { getConfig } from '../../lib/config';
import { isImageModelId, isReasoningModel } from '@mangostudio/shared/utils/model-detection';
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
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import {
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
  type ContinuationEnvelope,
} from './continuation';
import { getModelContextLimit } from './context-policy';
import { buildOpenAIResponsesReplay } from './replay-builder';

const BASE_URL = 'https://api.openai.com/v1';

// ---------------------------------------------------------------------------
// Shared OpenAI auth-context shape
// ---------------------------------------------------------------------------

/** All credentials needed to authenticate with the OpenAI API. */
export interface OpenAIAuthContext {
  apiKey: string;
  organizationId?: string | null;
  projectId?: string | null;
}

// ---------------------------------------------------------------------------
// Error classes for actionable connector failures
// ---------------------------------------------------------------------------

/** Thrown when OpenAI rejects the key or auth context (HTTP 401 / 403). */
export class OpenAIAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenAIAuthError';
    this.status = status;
  }
}

/** Thrown when the connector configuration is incomplete or malformed. */
export class OpenAIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIConfigError';
  }
}

// ---------------------------------------------------------------------------
// SDK client factory
// ---------------------------------------------------------------------------

/**
 * Creates an OpenAI SDK client from a full auth context.
 * Passes organization and project so that project-scoped keys work correctly.
 */
function createClient(ctx: OpenAIAuthContext): OpenAI {
  return new OpenAI({
    apiKey: ctx.apiKey,
    baseURL: BASE_URL,
    ...(ctx.organizationId ? { organization: ctx.organizationId } : {}),
    ...(ctx.projectId ? { project: ctx.projectId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Auth-context validation — shared by both the route-level validateProviderKey
// and the provider's own validateApiKey method.
// ---------------------------------------------------------------------------

/**
 * Validates an OpenAI auth context by listing models through the SDK.
 * Uses the exact same client construction as runtime so that project/org
 * scoping cannot diverge between validation and generation.
 *
 * @throws {OpenAIAuthError} for 401 / 403 responses.
 * @throws {OpenAIConfigError} for other API errors that indicate bad config.
 */
export async function validateOpenAIAuthContext(ctx: OpenAIAuthContext): Promise<void> {
  const client = createClient(ctx);
  try {
    // Requesting only 1 model to minimize bandwidth; we only care that the
    // credentials are accepted.
    await client.models.list();
  } catch (err) {
    if (err instanceof OpenAIAPIError) {
      if (err.status === 401) {
        throw new OpenAIAuthError(
          'OpenAI API key is invalid or expired. Verify your key and try again.',
          401
        );
      }
      if (err.status === 403) {
        throw new OpenAIAuthError(
          'OpenAI access denied. Check that your organization ID, project ID, and key permissions are correct.',
          403
        );
      }
      throw new OpenAIConfigError(
        `OpenAI connector validation failed (HTTP ${err.status}): ${err.message}`
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Secret service — used for storage / key resolution
// ---------------------------------------------------------------------------

const secretService = createProviderSecretService({
  provider: 'openai',
  tomlSection: 'openai_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  /**
   * The validateFn here is only invoked by the secret-service layer when no
   * full row context is available (e.g. config-file keys). The route-level
   * validateProviderKey is the primary path for connector creation, which has
   * full auth context.
   */
  validateFn: async (apiKey) => {
    await validateOpenAIAuthContext({ apiKey });
  },
});

// ---------------------------------------------------------------------------
// Auth-context resolution for runtime calls
// ---------------------------------------------------------------------------

/**
 * Resolves the full OpenAI auth context (key + optional org/project) from the
 * first configured connector that matches the optional model filter.
 */
async function resolveAuthContext(userId: string, modelName?: string): Promise<OpenAIAuthContext> {
  await secretService.syncConfigFileConnectors(userId);
  const rows = await secretService.listMeta('openai', userId);

  for (const row of rows) {
    if (!row.configured) continue;
    const enabled: string[] = JSON.parse(row.enabledModels);
    if (modelName && enabled.length > 0 && !enabled.includes(modelName)) continue;

    const apiKey = await secretService.resolveSecretValue(row);
    if (apiKey) {
      return {
        apiKey,
        organizationId: (row as SecretMetadataRow).organizationId ?? null,
        projectId: (row as SecretMetadataRow).projectId ?? null,
      };
    }
  }

  throw new Error('No OpenAI API key is configured or enabled. Check your Connectors in Settings.');
}

// ---------------------------------------------------------------------------
// Model listing (cached)
// ---------------------------------------------------------------------------

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('openai', userId);

    let resolvedCtx: OpenAIAuthContext | null = null;
    for (const row of rows) {
      if (!row.configured) continue;
      const apiKey = await secretService.resolveSecretValue(row);
      if (apiKey) {
        resolvedCtx = {
          apiKey,
          organizationId: (row as SecretMetadataRow).organizationId ?? null,
          projectId: (row as SecretMetadataRow).projectId ?? null,
        };
        break;
      }
    }

    if (!resolvedCtx) return [];

    const allModels: ModelInfo[] = [];
    try {
      const client = createClient(resolvedCtx);
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
          inputTokenLimit: getModelContextLimit(model.id),
          capabilities: {
            text: !isImageModelId(model.id),
            image: isImageModelId(model.id),
            streaming: !isImageModelId(model.id),
            reasoning: isReasoningModel(model.id),
            tools: !isImageModelId(model.id),
            statefulContinuation: !isImageModelId(model.id),
            promptCaching: true,
            parallelToolCalls: !isImageModelId(model.id),
            reasoningWithTools: isReasoningModel(model.id),
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

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

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
// Responses API helpers for reasoning models
// ---------------------------------------------------------------------------

/**
 * Builds the `input` array for the Responses API from a TextGenerationRequest.
 * Maps history + current prompt into the shape expected by responses.create().
 */
function buildResponsesInput(req: TextGenerationRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  for (const msg of req.history) {
    messages.push({
      role: msg.role === 'ai' ? 'assistant' : 'user',
      content: msg.text,
    });
  }

  messages.push({ role: 'user', content: req.prompt });
  return messages;
}

/**
 * Extracts reasoning text from a completed response payload.
 * Tries summary array first, then falls back to reasoning content array.
 */
export function extractReasoningFromCompleted(response: Record<string, unknown>): string | null {
  const output = response?.output;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (item.type !== 'reasoning') continue;

    // Try summary array first
    if (Array.isArray(item.summary)) {
      const texts = item.summary
        .filter((s: Record<string, unknown>) => s.type === 'summary_text' && s.text)
        .map((s: Record<string, unknown>) => s.text as string);
      if (texts.length > 0) return texts.join('\n\n');
    }

    // Fallback: reasoning content array
    if (Array.isArray(item.content)) {
      const texts = item.content
        .filter((c: Record<string, unknown>) => c.type === 'reasoning_text' && c.text)
        .map((c: Record<string, unknown>) => c.text as string);
      if (texts.length > 0) return texts.join('\n\n');
    }
  }

  return null;
}

/**
 * Streams a reasoning model response using the OpenAI Responses API.
 * Handles all reasoning event families with proper deduplication.
 */
export async function* streamWithResponsesAPI(
  client: OpenAI,
  req: TextGenerationRequest
): AsyncIterable<StreamingChunk> {
  const effort = req.generationConfig?.reasoningEffort ?? 'medium';
  const input = buildResponsesInput(req);

  const stream = await (client as any).responses.create({
    model: req.modelName,
    input,
    ...(req.systemPrompt?.trim() ? { instructions: req.systemPrompt } : {}),
    stream: true,
    reasoning: {
      effort,
      summary: 'auto',
    },
  });

  // Deduplication state
  const seenSummaryDeltas = new Set<string>();
  let thinkingWasEmitted = false;
  let summaryEventsWereSeen = false;

  for await (const event of stream) {
    if (req.signal?.aborted) break;

    const ev = event as Record<string, any>;
    const type = ev.type as string;

    switch (type) {
      // --- Reasoning summary (preferred path) ---
      case 'response.reasoning_summary_text.delta': {
        const key = `${ev.item_id}:${ev.summary_index}`;
        seenSummaryDeltas.add(key);
        summaryEventsWereSeen = true;
        thinkingWasEmitted = true;
        if (ev.delta) yield { type: 'thinking', text: ev.delta, done: false };
        break;
      }

      // --- Raw reasoning text (fallback when no summary) ---
      case 'response.reasoning_text.delta': {
        if (!summaryEventsWereSeen) {
          thinkingWasEmitted = true;
          if (ev.delta) yield { type: 'thinking', text: ev.delta, done: false };
        }
        break;
      }

      // --- Summary done events (fallback if no delta was streamed) ---
      case 'response.reasoning_summary_text.done': {
        const key = `${ev.item_id}:${ev.summary_index}`;
        if (!seenSummaryDeltas.has(key) && ev.text) {
          thinkingWasEmitted = true;
          yield { type: 'thinking', text: ev.text, done: false };
        }
        break;
      }

      case 'response.reasoning_summary_part.done': {
        if (ev.part?.type === 'summary_text' && ev.part.text) {
          const key = `${ev.item_id}:${ev.summary_index}`;
          if (!seenSummaryDeltas.has(key)) {
            thinkingWasEmitted = true;
            yield { type: 'thinking', text: ev.part.text, done: false };
          }
        }
        break;
      }

      case 'response.reasoning_text.done': {
        if (!summaryEventsWereSeen && !thinkingWasEmitted && ev.text) {
          yield { type: 'thinking', text: ev.text, done: false };
          thinkingWasEmitted = true;
        }
        break;
      }

      // --- Assistant text ---
      case 'response.output_text.delta': {
        if (ev.delta) yield { type: 'text', text: ev.delta, done: false };
        break;
      }

      // --- Final response fallback ---
      case 'response.completed': {
        if (!thinkingWasEmitted && ev.response) {
          const reasoning = extractReasoningFromCompleted(ev.response);
          if (reasoning) {
            yield { type: 'thinking', text: reasoning, done: false };
          }
        }
        break;
      }
    }
  }

  yield { type: 'text', text: '', done: true };
}

// ---------------------------------------------------------------------------
// Responses API tool format
// ---------------------------------------------------------------------------

/** Converts a provider-agnostic ToolDefinition into the Responses API tool format. */
function toResponsesTool(def: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    strict: false,
  };
}

/** Parses the OpenAI providerState JSON, returning the responseId or null. */
function parseResponseId(providerState: string | null | undefined): string | null {
  // Try new envelope format first
  const envelope = parseContinuationEnvelope(providerState);
  if (envelope?.provider === 'openai' && envelope.cursor) {
    return envelope.cursor;
  }
  // Legacy fallback: try old format
  if (!providerState) return null;
  try {
    const parsed = JSON.parse(providerState) as Record<string, unknown>;
    if (parsed.provider === 'openai' && typeof parsed.responseId === 'string') {
      return parsed.responseId;
    }
  } catch {
    // Ignore malformed state
  }
  return null;
}

/**
 * Streams a single agentic turn using the OpenAI Responses API.
 * Supports tool calling with server-side continuation via previous_response_id.
 *
 * Fallback: if the cursor is invalid/expired (404), retries without previous_response_id
 * (full history replay) and logs a warning.
 */
async function* streamAgentTurnWithResponsesAPI(
  client: OpenAI,
  req: AgentTurnRequest
): AsyncIterable<AgentEvent> {
  const tools = (req.toolDefinitions ?? []).map(toResponsesTool);
  const previousResponseId = parseResponseId(req.providerState);
  const effort = req.generationConfig?.reasoningEffort ?? 'medium';
  const useReasoning = isReasoningModel(req.modelName) && req.generationConfig?.thinkingEnabled;

  // Build the input array for this request
  let input: Array<Record<string, unknown>>;

  if (req.toolResults && req.toolResults.length > 0) {
    // Tool-result continuation — send function_call_output items
    input = req.toolResults.map((tr) => ({
      type: 'function_call_output',
      call_id: tr.callId,
      output: tr.result,
    }));
  } else if (previousResponseId) {
    // Stateful continuation — send only the new user message
    input = req.prompt ? [{ role: 'user', content: req.prompt }] : [];
  } else {
    // Full history replay (first call or cursor invalidated).
    // Structured replay: preserves tool-call/tool-result history from persisted parts.
    input = [
      ...buildOpenAIResponsesReplay(req.history),
      ...(req.prompt ? [{ role: 'user', content: req.prompt }] : []),
    ];
  }

  const makeRequest = async (prevId: string | null) => {
    return (client as any).responses.create({
      model: req.modelName,
      input,
      ...(req.systemPrompt?.trim() ? { instructions: req.systemPrompt } : {}),
      ...(prevId ? { previous_response_id: prevId } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      store: true,
      stream: true,
      ...(useReasoning ? { reasoning: { effort, summary: 'concise' } } : {}),
    });
  };

  let stream: AsyncIterable<Record<string, any>>;
  try {
    stream = await makeRequest(previousResponseId);
  } catch (err: unknown) {
    const isCursorError =
      err instanceof OpenAIAPIError &&
      (err.status === 404 ||
        err.status === 409 ||
        (err.status === 400 && /previous_response_id/i.test(err.message)));
    const canFallback = isCursorError && previousResponseId && !req.toolResults;
    if (canFallback) {
      const status = err instanceof OpenAIAPIError ? err.status : 'unknown';
      console.warn(
        `[fallback][degrade] provider=openai reason=cursor_error status=${status}` +
          ` falling back to full replay`
      );
      // Note: err instanceof OpenAIAPIError was already checked above via isCursorError
      // Rebuild input from full history using structured replay.
      input = [
        ...buildOpenAIResponsesReplay(req.history),
        ...(req.prompt ? [{ role: 'user', content: req.prompt }] : []),
      ];
      stream = await makeRequest(null);
    } else {
      throw err;
    }
  }

  // Deduplication state for reasoning events
  const seenSummaryDeltas = new Set<string>();
  let summaryEventsWereSeen = false;
  let thinkingWasEmitted = false;
  let newResponseId: string | null = null;
  let usageInputTokens: number | undefined;

  // Map output item IDs (fc_xxx) → function call IDs (call_xxx) for consistent callId
  const itemIdToCallId = new Map<string, { callId: string; name: string }>();

  for await (const event of stream) {
    if (req.signal?.aborted) break;

    const ev = event as Record<string, any>;
    const type = ev.type as string;

    switch (type) {
      case 'response.reasoning_summary_text.delta': {
        const key = `${ev.item_id}:${ev.summary_index}`;
        seenSummaryDeltas.add(key);
        summaryEventsWereSeen = true;
        thinkingWasEmitted = true;
        if (ev.delta) yield { type: 'reasoning_delta', text: ev.delta };
        break;
      }

      case 'response.reasoning_text.delta': {
        if (!summaryEventsWereSeen && ev.delta) {
          thinkingWasEmitted = true;
          yield { type: 'reasoning_delta', text: ev.delta };
        }
        break;
      }

      case 'response.reasoning_summary_text.done': {
        const key = `${ev.item_id}:${ev.summary_index}`;
        if (!seenSummaryDeltas.has(key) && ev.text) {
          thinkingWasEmitted = true;
          yield { type: 'reasoning_delta', text: ev.text };
        }
        break;
      }

      case 'response.reasoning_summary_part.done': {
        if (ev.part?.type === 'summary_text' && ev.part.text) {
          const key = `${ev.item_id}:${ev.summary_index}`;
          if (!seenSummaryDeltas.has(key)) {
            thinkingWasEmitted = true;
            yield { type: 'reasoning_delta', text: ev.part.text };
          }
        }
        break;
      }

      case 'response.reasoning_text.done': {
        if (!summaryEventsWereSeen && !thinkingWasEmitted && ev.text) {
          yield { type: 'reasoning_delta', text: ev.text };
          thinkingWasEmitted = true;
        }
        break;
      }

      case 'response.output_item.added': {
        const item = ev.item as Record<string, any> | undefined;
        if (item?.type === 'function_call') {
          const callId: string = item.call_id ?? item.id;
          itemIdToCallId.set(item.id, { callId, name: item.name ?? '' });
          yield { type: 'tool_call_started', callId, name: item.name };
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const mapped = itemIdToCallId.get(ev.item_id);
        if (ev.delta && mapped) {
          yield {
            type: 'tool_call_arguments_delta',
            callId: mapped.callId,
            delta: ev.delta,
          };
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const mapped = itemIdToCallId.get(ev.item_id);
        if (mapped) {
          yield {
            type: 'tool_call_completed',
            callId: mapped.callId,
            name: mapped.name,
            arguments: ev.arguments ?? '',
          };
        }
        break;
      }

      case 'response.output_text.delta': {
        if (ev.delta) yield { type: 'assistant_text_delta', text: ev.delta };
        break;
      }

      case 'response.completed': {
        newResponseId = ev.response?.id ?? null;
        const usage = ev.response?.usage as Record<string, any> | undefined;
        if (usage && typeof usage.input_tokens === 'number') {
          usageInputTokens = usage.input_tokens;
        }
        if (!thinkingWasEmitted && ev.response) {
          const reasoning = extractReasoningFromCompleted(ev.response);
          if (reasoning) {
            yield { type: 'reasoning_delta', text: reasoning };
          }
        }
        break;
      }
    }
  }

  const envelope: ContinuationEnvelope = {
    schemaVersion: 1,
    provider: 'openai',
    mode: 'responses',
    modelName: req.modelName,
    systemPromptHash: computeSystemPromptHash(req.systemPrompt),
    toolsetHash: computeToolsetHash(req.toolDefinitions ?? []),
    cursor: newResponseId ?? undefined,
    context: {
      providerReportedInputTokens: usageInputTokens,
      contextLimit: getModelContextLimit(req.modelName),
      lastUpdatedAt: Date.now(),
    },
  };

  yield { type: 'turn_completed', providerState: serializeContinuationEnvelope(envelope) };
}

/**
 * Streams a non-reasoning model response using the Chat Completions API.
 */
async function* streamWithChatCompletions(
  client: OpenAI,
  req: TextGenerationRequest
): AsyncIterable<StreamingChunk> {
  const stream = await client.chat.completions.create(
    { model: req.modelName, messages: buildMessages(req), stream: true },
    { signal: req.signal }
  );

  for await (const chunk of stream) {
    if (req.signal?.aborted) break;
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield { type: 'text', text: delta, done: false };
  }
  yield { type: 'text', text: '', done: true };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const openAIProvider: AIProvider = {
  providerType: 'openai',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createClient(ctx);

    const completion = await client.chat.completions.create(
      { model: req.modelName, messages: buildMessages(req), stream: false },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createClient(ctx);

    if (isReasoningModel(req.modelName) && req.generationConfig?.thinkingEnabled) {
      yield* streamWithResponsesAPI(client, req);
    } else {
      yield* streamWithChatCompletions(client, req);
    }
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createClient(ctx);
    yield* streamAgentTurnWithResponsesAPI(client, req);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!isImageModelId(req.modelName)) {
      throw new Error(`Image generation is not supported by model "${req.modelName}".`);
    }

    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createClient(ctx);

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

  /**
   * Validates an API key using SDK-backed model listing.
   * Delegates to validateOpenAIAuthContext so that validation and runtime
   * share the same code path.
   */
  async validateApiKey(apiKey: string): Promise<void> {
    await validateOpenAIAuthContext({ apiKey });
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { apiKey } = await resolveAuthContext(userId, modelName);
    return apiKey;
  },
};

// Self-register on import
registerProvider(openAIProvider);

export { openAIProvider };
