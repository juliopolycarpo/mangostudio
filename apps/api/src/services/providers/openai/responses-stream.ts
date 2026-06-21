/**
 * OpenAI Responses API streaming implementations.
 *
 * Covers both simple text streaming (with reasoning) and the full
 * agentic turn loop (tool calling + continuation via previous_response_id).
 */

import type { ReasoningEffort } from '@mangostudio/shared';
import type OpenAI from 'openai';
import { type APIPromise, APIError as OpenAIAPIError } from 'openai';
import type { Stream } from 'openai/streaming';
import { parseJsonWith } from '../../../lib/safe-parse';
import {
  type AgentTurnStreamOpenResult,
  streamAgentTurnLoop,
} from '../core/agent-turn-stream-loop';
import { isReasoningModel } from '../core/capability-detector';
import { getModelContextLimit } from '../core/context-policy';
import {
  createContinuationEnvelope,
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
} from '../core/continuation-envelope';
import { logProviderDegrade } from '../core/continuation-logger';
import { buildOpenAIResponsesReplay } from '../core/replay-builder';
import { toolDefsToResponsesAPI } from '../core/tool-mapper';
import type { AgentEvent, AgentTurnRequest, StreamingChunk, TextGenerationRequest } from '../types';
import { buildOpenAIResponsesUserMessage } from './message-mapper';
import type { ResponseStreamEvent } from './normalizers';
import { createResponsesAgentAccumulator } from './responses-agent-accumulator';
import { createResponsesReasoningTracker } from './responses-reasoning-tracker';

// ---------------------------------------------------------------------------
// SDK boundary casts — OpenAI Responses API
//
// The SDK's ResponseInput and Tool types are complex unions that don't
// accept plain {role, content} objects or our tool definition shapes.
// These wrappers contain the single cast per pattern.
// ---------------------------------------------------------------------------

function toResponseInput(input: Array<Record<string, unknown>>): OpenAI.Responses.ResponseInput {
  return input as unknown as OpenAI.Responses.ResponseInput;
}

function toResponseTools(tools: Array<Record<string, unknown>>): OpenAI.Responses.Tool[] {
  return tools as unknown as OpenAI.Responses.Tool[];
}

// ---------------------------------------------------------------------------
// Responses create params builder
//
// Centralised construction so first call, cursor continuation, and replay
// retry all produce the same request shape.
// ---------------------------------------------------------------------------

interface BuildResponsesCreateParamsOptions {
  model: string;
  input: Array<Record<string, unknown>>;
  instructions?: string;
  tools?: Array<Record<string, unknown>>;
  previousResponseId?: string | null;
  useReasoning?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  textFormat?: Record<string, unknown>;
  enableCompaction?: boolean;
  providerCompactionThreshold?: number;
  contextLimit: number;
}

function resolveProviderCompactionThreshold(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(0.99, Math.max(0.5, value as number));
}

function buildResponsesCreateParams(
  options: BuildResponsesCreateParamsOptions
): Record<string, unknown> {
  const {
    model,
    input,
    instructions,
    tools,
    previousResponseId,
    useReasoning,
    reasoningEffort = 'medium',
    textFormat,
    enableCompaction = true,
    providerCompactionThreshold,
    contextLimit,
  } = options;

  const compactThreshold = Math.floor(
    contextLimit * resolveProviderCompactionThreshold(providerCompactionThreshold)
  );
  const canCompact = previousResponseId && enableCompaction;
  const contextManagement = canCompact
    ? { context_management: [{ type: 'compaction', compact_threshold: compactThreshold }] }
    : {};

  return {
    model,
    input: toResponseInput(input),
    ...(instructions?.trim() ? { instructions } : {}),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    ...(tools && tools.length > 0 ? { tools: toResponseTools(tools) } : {}),
    store: true,
    stream: true,
    ...(useReasoning ? { reasoning: { effort: reasoningEffort, summary: 'concise' } } : {}),
    ...contextManagement,
    ...(textFormat ?? {}),
  };
}

/**
 * Builds the `text.format` segment for structured output (JSON Schema) mode.
 * Returns an empty object when no structured output is requested.
 */
function buildStructuredTextFormat(
  structured: { name: string; schema: Record<string, unknown>; strict?: boolean } | undefined
): Record<string, unknown> {
  if (!structured) return {};
  return {
    text: {
      format: {
        type: 'json_schema' as const,
        name: structured.name,
        schema: structured.schema,
        strict: structured.strict ?? true,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Text streaming (reasoning models via Responses API)
// ---------------------------------------------------------------------------

/**
 * Streams a reasoning model response using the OpenAI Responses API.
 * Handles all reasoning event families with proper deduplication.
 */
export async function* streamWithResponsesAPI(
  client: OpenAI,
  req: TextGenerationRequest
): AsyncIterable<StreamingChunk> {
  const rawEffort = req.generationConfig?.reasoningEffort ?? 'medium';
  const effort = normalizeOpenAIReasoningEffort(rawEffort);
  const input = [
    ...req.history.map((msg) => ({
      role: msg.role === 'ai' ? 'assistant' : 'user',
      content: msg.text,
    })),
    ...currentResponsesUserInput(req),
  ];

  const stream = await client.responses.create(
    {
      model: req.modelName,
      input: toResponseInput(input),
      ...(req.systemPrompt?.trim() ? { instructions: req.systemPrompt } : {}),
      stream: true,
      reasoning: { effort, summary: 'auto' },
      ...buildStructuredTextFormat(req.generationConfig?.structuredOutput),
    },
    { signal: req.signal }
  );

  const reasoning = createResponsesReasoningTracker();

  for await (const ev of stream) {
    if (req.signal?.aborted) break;

    const reasoningText = reasoning.consumeStreamEvent(ev);
    if (reasoningText !== null) {
      yield { type: 'thinking', text: reasoningText, done: false };
      continue;
    }

    if (ev.type === 'response.output_text.delta') {
      if (ev.delta) yield { type: 'text', text: ev.delta, done: false };
    } else if (ev.type === 'response.completed') {
      const fallback = reasoning.consumeCompleted(ev.response);
      if (fallback) yield { type: 'thinking', text: fallback, done: false };
    }
  }

  yield { type: 'text', text: '', done: true };
}

// ---------------------------------------------------------------------------
// Agentic turn streaming (tool calling + continuation)
// ---------------------------------------------------------------------------

/** Parses the OpenAI providerState JSON, returning the responseId or null. */
function parseResponseId(providerState: string | null | undefined): string | null {
  // Try new envelope format first
  const envelope = parseContinuationEnvelope(providerState);
  if (envelope?.provider === 'openai' && envelope.cursor) {
    return envelope.cursor;
  }
  // Legacy fallback: try old format
  return parseJsonWith(providerState, (parsed) => {
    if (parsed.provider === 'openai' && typeof parsed.responseId === 'string') {
      return parsed.responseId;
    }
    return null;
  });
}

/**
 * Streams a single agentic turn using the OpenAI Responses API.
 * Supports tool calling with server-side continuation via previous_response_id.
 *
 * Fallback: if the cursor is invalid/expired (404), retries without previous_response_id
 * (full history replay) and logs a warning.
 */
export async function* streamAgentTurnWithResponsesAPI(
  client: OpenAI,
  req: AgentTurnRequest
): AsyncGenerator<AgentEvent> {
  const tools = toolDefsToResponsesAPI(req.toolDefinitions ?? []);
  const previousResponseId = parseResponseId(req.providerState);
  const rawEffort2 = req.generationConfig?.reasoningEffort ?? 'medium';
  const effort = normalizeOpenAIReasoningEffort(rawEffort2);
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
    input = currentResponsesUserInput(req);
  } else {
    // Full history replay (first call or cursor invalidated).
    input = [...buildOpenAIResponsesReplay(req.history), ...currentResponsesUserInput(req)];
  }

  const contextLimit = getModelContextLimit(req.modelName);
  const textFormat = buildStructuredTextFormat(req.generationConfig?.structuredOutput);

  const makeRequest = (prevId: string | null): APIPromise<Stream<ResponseStreamEvent>> => {
    const params = buildResponsesCreateParams({
      model: req.modelName,
      input,
      instructions: req.systemPrompt,
      tools,
      previousResponseId: prevId,
      useReasoning,
      reasoningEffort: effort,
      textFormat,
      enableCompaction: req.generationConfig?.enableProviderCompaction ?? true,
      providerCompactionThreshold: req.generationConfig?.providerCompactionThreshold,
      contextLimit,
    }) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;
    return client.responses.create(params, { signal: req.signal });
  };

  const openStream = async (): Promise<AgentTurnStreamOpenResult<ResponseStreamEvent>> => {
    try {
      return { stream: await makeRequest(previousResponseId) };
    } catch (err: unknown) {
      const isCursorError =
        err instanceof OpenAIAPIError &&
        (err.status === 404 ||
          err.status === 409 ||
          (err.status === 400 && /previous_response_id/i.test(err.message)));
      const canFallback = isCursorError && previousResponseId;
      if (!canFallback) throw err;

      const status = err instanceof OpenAIAPIError ? (err.status as number) : 'unknown';

      if (req.toolResults) {
        // Tool-result continuation cannot be replayed safely: replaying from history
        // would silently drop the in-flight tool results. Use a distinct 'to' value
        // rather than the generic 'error' so callers can distinguish this case.
        // Stale durable state must be cleared by the orchestrator after this failure.
        logProviderDegrade({
          provider: 'openai',
          reason: 'cursor_error',
          reasonCode: 'tool_result_cursor_loss',
          status,
          toolResults: true,
        });
        return {
          terminalEvents: [
            {
              type: 'continuation_degraded',
              from: 'responses',
              to: 'tool_loop_aborted',
              reason: `cursor_error during tool-result continuation (status=${status})`,
              reasonCode: 'tool_result_cursor_loss' as const,
            },
            {
              type: 'turn_error',
              error:
                'Server-side continuation cursor expired during tool execution. The response may be incomplete.',
            },
          ],
        };
      }

      // 404 = expired; 400/409 = invalid request shape referencing the prior response.
      const reasonCode: 'cursor_expired' | 'cursor_invalid' =
        err instanceof OpenAIAPIError && err.status === 404 ? 'cursor_expired' : 'cursor_invalid';
      logProviderDegrade({
        provider: 'openai',
        reason: reasonCode,
        reasonCode,
        status,
      });
      input = [...buildOpenAIResponsesReplay(req.history), ...currentResponsesUserInput(req)];
      return {
        preludeEvents: [
          {
            type: 'continuation_degraded',
            from: 'responses',
            to: 'replay',
            reason: `cursor_error (status=${status})`,
            reasonCode,
          },
        ],
        stream: await makeRequest(null),
      };
    }
  };

  yield* streamAgentTurnLoop({
    signal: req.signal,
    completeOnAbort: true,
    openStream,
    createAccumulator: createResponsesAgentAccumulator,
    createContext: () => undefined,
    mapChunk: ({ chunk, accumulator }) => accumulator.mapEvent(chunk),
    complete: ({ accumulator }) => [
      {
        type: 'turn_completed' as const,
        providerState: serializeContinuationEnvelope(
          createContinuationEnvelope(
            'openai',
            'responses',
            req,
            accumulator.responseId ?? undefined,
            {
              providerReportedInputTokens: accumulator.usageInputTokens,
              contextLimit: getModelContextLimit(req.modelName),
            }
          )
        ),
      },
    ],
  });
}

function currentResponsesUserInput(
  req: Pick<
    AgentTurnRequest | TextGenerationRequest,
    'prompt' | 'attachments' | 'modelCapabilities'
  >
): Record<string, unknown>[] {
  const userMessage = buildOpenAIResponsesUserMessage(req);
  return userMessage ? [userMessage] : [];
}

function normalizeOpenAIReasoningEffort(
  effort: ReasoningEffort
): 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  return 'high';
}
