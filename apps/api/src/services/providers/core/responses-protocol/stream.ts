/**
 * Shared Responses protocol streaming implementations.
 *
 * Covers both simple text streaming (with reasoning) and the full agentic turn
 * loop (tool calling + continuation policy).
 */

import type OpenAI from 'openai';
import { type APIPromise, APIError as OpenAIAPIError } from 'openai';
import type { Stream } from 'openai/streaming';
import { parseJsonWith } from '../../../../lib/safe-parse';
import type {
  AgentEvent,
  AgentTurnRequest,
  StreamingChunk,
  TextGenerationRequest,
} from '../../types';
import { type AgentTurnStreamOpenResult, streamAgentTurnLoop } from '../agent-turn-stream-loop';
import { isReasoningModel } from '../capability-detector';
import { getModelContextLimit } from '../context-policy';
import {
  createContinuationEnvelope,
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
} from '../continuation-envelope';
import { logProviderDegrade } from '../continuation-logger';
import { toolDefsToResponsesAPI } from '../tool-mapper';
import { createResponsesAgentAccumulator } from './agent-accumulator';
import type { ResponseStreamEvent } from './normalizers';
import { createResponsesReasoningTracker } from './reasoning-tracker';
import {
  buildResponsesAgentTurnInput,
  buildResponsesCreateParams,
  buildResponsesRequestOptions,
  buildResponsesTextInput,
  buildStructuredTextFormat,
  normalizeResponsesReasoningEffort,
  type ResponsesRequestPolicy,
  resolveResponsesInstructions,
} from './request-builder';

// ---------------------------------------------------------------------------
// Text streaming (reasoning models via Responses protocol)
// ---------------------------------------------------------------------------

/**
 * Streams a reasoning model response using the Responses protocol.
 * Handles all reasoning event families with proper deduplication.
 */
export async function* streamResponses(
  client: OpenAI,
  req: TextGenerationRequest,
  policy: ResponsesRequestPolicy
): AsyncIterable<StreamingChunk> {
  const rawEffort = req.generationConfig?.reasoningEffort ?? 'medium';
  const effort = normalizeResponsesReasoningEffort(rawEffort);
  const params = buildResponsesCreateParams({
    model: req.modelName,
    input: buildResponsesTextInput(req),
    instructions: resolveResponsesInstructions(req.systemPrompt, policy),
    policy,
    useReasoning: true,
    reasoningEffort: effort,
    reasoningSummary: 'auto',
    textFormat: buildStructuredTextFormat(req.generationConfig?.structuredOutput),
    maxOutputTokens: req.generationConfig?.maxOutputTokens,
    contextLimit: getModelContextLimit(req.modelName),
  }) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;

  const stream = await client.responses.create(
    params,
    buildResponsesRequestOptions(req.signal, policy)
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

/** Parses providerState JSON, returning a previous response id or null. */
function parsePreviousResponseId(
  providerState: string | null | undefined,
  policy: ResponsesRequestPolicy
): string | null {
  if (policy.continuation !== 'previous-response-id') return null;

  const envelope = parseContinuationEnvelope(providerState);
  if (envelope?.provider === policy.provider && envelope.mode === 'responses' && envelope.cursor) {
    return envelope.cursor;
  }

  // Legacy OpenAI fallback: old providerState format before continuation envelopes.
  if (policy.provider !== 'openai') return null;
  return parseJsonWith(providerState, (parsed) => {
    if (parsed.provider === 'openai' && typeof parsed.responseId === 'string') {
      return parsed.responseId;
    }
    return null;
  });
}

/**
 * Streams a single agentic turn using the Responses protocol.
 *
 * The `previous-response-id` policy supports server-side continuation and
 * retry-to-replay when the cursor is invalid or expired. The `stateless-replay`
 * policy always assembles full input and never retries as a cursor chain.
 */
export async function* streamAgentTurnWithResponses(
  client: OpenAI,
  req: AgentTurnRequest,
  policy: ResponsesRequestPolicy
): AsyncGenerator<AgentEvent> {
  const tools = toolDefsToResponsesAPI(req.toolDefinitions ?? []);
  const previousResponseId = parsePreviousResponseId(req.providerState, policy);
  const rawEffort = req.generationConfig?.reasoningEffort ?? 'medium';
  const effort = normalizeResponsesReasoningEffort(rawEffort);
  const useReasoning = isReasoningModel(req.modelName) && req.generationConfig?.thinkingEnabled;
  const contextLimit = getModelContextLimit(req.modelName);
  const textFormat = buildStructuredTextFormat(req.generationConfig?.structuredOutput);

  let input = buildResponsesAgentTurnInput({ req, policy, previousResponseId });

  const makeRequest = (prevId: string | null): APIPromise<Stream<ResponseStreamEvent>> => {
    const params = buildResponsesCreateParams({
      model: req.modelName,
      input,
      instructions: resolveResponsesInstructions(req.systemPrompt, policy),
      policy,
      tools,
      previousResponseId: prevId,
      useReasoning,
      reasoningEffort: effort,
      textFormat,
      maxOutputTokens: req.generationConfig?.maxOutputTokens,
      enableCompaction: req.generationConfig?.enableProviderCompaction ?? true,
      providerCompactionThreshold: req.generationConfig?.providerCompactionThreshold,
      contextLimit,
    }) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;
    return client.responses.create(params, buildResponsesRequestOptions(req.signal, policy));
  };

  const openStream = async (): Promise<AgentTurnStreamOpenResult<ResponseStreamEvent>> => {
    try {
      return { stream: await makeRequest(previousResponseId) };
    } catch (err: unknown) {
      if (policy.continuation !== 'previous-response-id') throw err;

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
          provider: policy.provider,
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
        provider: policy.provider,
        reason: reasonCode,
        reasonCode,
        status,
      });
      input = buildResponsesAgentTurnInput({ req, policy, previousResponseId: null });
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
    complete: ({ accumulator }) => {
      if (policy.continuation !== 'previous-response-id') {
        return [{ type: 'turn_completed' as const }];
      }

      return [
        {
          type: 'turn_completed' as const,
          providerState: serializeContinuationEnvelope(
            createContinuationEnvelope(
              policy.provider,
              'responses',
              req,
              accumulator.responseId ?? undefined,
              {
                providerReportedInputTokens: accumulator.usageInputTokens,
                contextLimit,
              }
            )
          ),
        },
      ];
    },
  });
}
