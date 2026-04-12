/**
 * OpenAI Responses API streaming implementations.
 *
 * Covers both simple text streaming (with reasoning) and the full
 * agentic turn loop (tool calling + continuation via previous_response_id).
 */

import type OpenAI from 'openai';
import { APIError as OpenAIAPIError, type APIPromise } from 'openai';
import type { Stream } from 'openai/streaming';
import { isReasoningModel } from '../core/capability-detector';
import { getModelContextLimit } from '../core/context-policy';
import { buildOpenAIResponsesReplay } from '../core/replay-builder';
import { toolDefsToResponsesAPI } from '../core/tool-mapper';
import {
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
  type ContinuationEnvelope,
} from '../core/continuation-envelope';
import {
  extractReasoningFromCompleted,
  extractResponsesUsage,
  type ResponseStreamEvent,
} from './normalizers';
import type { TextGenerationRequest, StreamingChunk, AgentTurnRequest, AgentEvent } from '../types';

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
  const effort = req.generationConfig?.reasoningEffort ?? 'medium';
  const input = [
    ...req.history.map((msg) => ({
      role: msg.role === 'ai' ? 'assistant' : 'user',
      content: msg.text,
    })),
    { role: 'user', content: req.prompt },
  ];

  const stream = await client.responses.create({
    model: req.modelName,
    input: input as unknown as OpenAI.Responses.ResponseInput,
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

  for await (const ev of stream) {
    if (req.signal?.aborted) break;

    switch (ev.type) {
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
        if (ev.part.text) {
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
        if (!thinkingWasEmitted) {
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
export async function* streamAgentTurnWithResponsesAPI(
  client: OpenAI,
  req: AgentTurnRequest
): AsyncGenerator<AgentEvent> {
  const tools = toolDefsToResponsesAPI(req.toolDefinitions ?? []);
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
    input = [
      ...buildOpenAIResponsesReplay(req.history),
      ...(req.prompt ? [{ role: 'user', content: req.prompt }] : []),
    ];
  }

  const makeRequest = (prevId: string | null): APIPromise<Stream<ResponseStreamEvent>> => {
    return client.responses.create({
      model: req.modelName,
      input: input as unknown as OpenAI.Responses.ResponseInput,
      ...(req.systemPrompt?.trim() ? { instructions: req.systemPrompt } : {}),
      ...(prevId ? { previous_response_id: prevId } : {}),
      ...(tools.length > 0 ? { tools: tools as unknown as OpenAI.Responses.Tool[] } : {}),
      store: true,
      stream: true,
      ...(useReasoning ? { reasoning: { effort, summary: 'concise' } } : {}),
    });
  };

  let stream: AsyncIterable<ResponseStreamEvent>;
  try {
    stream = await makeRequest(previousResponseId);
  } catch (err: unknown) {
    const isCursorError =
      err instanceof OpenAIAPIError &&
      (err.status === 404 ||
        err.status === 409 ||
        (err.status === 400 && /previous_response_id/i.test(err.message)));
    const canFallback = isCursorError && previousResponseId;
    if (canFallback) {
      const status = err instanceof OpenAIAPIError ? (err.status as number) : 'unknown';

      if (req.toolResults) {
        console.warn(
          `[fallback][degrade] provider=openai reason=cursor_error status=${status}` +
            ` toolResults=true cannot recover — yielding turn_error`
        );
        yield {
          type: 'continuation_degraded',
          from: 'responses',
          to: 'error',
          reason: `cursor_error during tool-result continuation (status=${status})`,
        };
        yield {
          type: 'turn_error',
          error: `Server-side continuation cursor expired during tool execution. The response may be incomplete.`,
        };
        return;
      }

      console.warn(
        `[fallback][degrade] provider=openai reason=cursor_error status=${status}` +
          ` falling back to full replay`
      );
      yield {
        type: 'continuation_degraded',
        from: 'responses',
        to: 'replay',
        reason: `cursor_error (status=${status})`,
      };
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

  for await (const ev of stream) {
    if (req.signal?.aborted) break;

    switch (ev.type) {
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
        if (ev.part.text) {
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
        if (ev.item.type === 'function_call') {
          const callId = ev.item.call_id;
          const itemId = ev.item.id ?? callId;
          itemIdToCallId.set(itemId, { callId, name: ev.item.name });
          yield { type: 'tool_call_started', callId, name: ev.item.name };
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
        newResponseId = ev.response.id;
        const ru = extractResponsesUsage(ev.response);
        if (ru.inputTokens) usageInputTokens = ru.inputTokens;
        if (!thinkingWasEmitted) {
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
