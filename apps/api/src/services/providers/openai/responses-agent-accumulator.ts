/**
 * Maps raw OpenAI Responses stream events into canonical AgentEvents.
 *
 * Owns the per-turn state the agentic loop needs: reasoning deduplication
 * (delegated to the reasoning tracker), function-call bookkeeping that bridges
 * output-item ids to stable call ids, and the terminal response id / usage used
 * to mint the continuation envelope.
 */

import type { Responses } from 'openai/resources/responses/responses';
import type { AgentEvent } from '../types';
import { extractResponsesUsage, type ResponseStreamEvent } from './normalizers';
import { createResponsesReasoningTracker } from './responses-reasoning-tracker';

interface PendingFunctionCall {
  callId: string;
  name: string;
}

export interface ResponsesAgentAccumulator {
  /** Maps one raw Responses stream event into zero or more AgentEvents. */
  mapEvent(ev: ResponseStreamEvent): AgentEvent[];
  /** Server-side response id captured from `response.completed`, or null. */
  readonly responseId: string | null;
  /** Provider-reported input tokens from `response.completed` usage, if any. */
  readonly usageInputTokens: number | undefined;
}

/** Builds an accumulator for a single agentic Responses stream. */
// Usage: const accumulator = createResponsesAgentAccumulator();
export function createResponsesAgentAccumulator(): ResponsesAgentAccumulator {
  const reasoning = createResponsesReasoningTracker();
  // Output item ids (fc_xxx) → function call ids (call_xxx) for a stable callId.
  const itemIdToCallId = new Map<string, PendingFunctionCall>();
  let responseId: string | null = null;
  let usageInputTokens: number | undefined;

  const mapToolEvent = (ev: ResponseStreamEvent): AgentEvent[] => {
    switch (ev.type) {
      case 'response.output_item.added': {
        if (ev.item.type !== 'function_call') return [];
        const callId = ev.item.call_id;
        const itemId = ev.item.id ?? callId;
        itemIdToCallId.set(itemId, { callId, name: ev.item.name });
        return [{ type: 'tool_call_started', callId, name: ev.item.name }];
      }

      case 'response.function_call_arguments.delta': {
        const mapped = itemIdToCallId.get(ev.item_id);
        if (!mapped || !ev.delta) return [];
        return [{ type: 'tool_call_arguments_delta', callId: mapped.callId, delta: ev.delta }];
      }

      case 'response.function_call_arguments.done': {
        const mapped = itemIdToCallId.get(ev.item_id);
        if (!mapped) return [];
        return [
          {
            type: 'tool_call_completed',
            callId: mapped.callId,
            name: mapped.name,
            arguments: ev.arguments,
          },
        ];
      }

      case 'response.output_text.delta':
        return ev.delta ? [{ type: 'assistant_text_delta', text: ev.delta }] : [];

      case 'response.completed':
        return mapCompleted(ev.response);

      default:
        return [];
    }
  };

  const mapCompleted = (response: Responses.Response): AgentEvent[] => {
    responseId = response.id;
    const usage = extractResponsesUsage(response);
    if (usage.inputTokens) usageInputTokens = usage.inputTokens;

    const fallback = reasoning.consumeCompleted(response);
    return fallback ? [{ type: 'reasoning_delta', text: fallback }] : [];
  };

  return {
    mapEvent(ev) {
      const reasoningText = reasoning.consumeStreamEvent(ev);
      if (reasoningText !== null) return [{ type: 'reasoning_delta', text: reasoningText }];
      return mapToolEvent(ev);
    },
    get responseId() {
      return responseId;
    },
    get usageInputTokens() {
      return usageInputTokens;
    },
  };
}
