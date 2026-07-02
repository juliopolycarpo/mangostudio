/**
 * Maps Cursor sidecar streaming chunks to the standard AgentEvent contract.
 *
 * The Cursor SDK runs its own tool loop inside the sidecar (custom tools
 * execute via the stdio RPC bridge back to the API), so the provider emits the
 * full agent-turn event stream — including tool_result events — and finishes
 * with turn_completed carrying no pending calls. The orchestrator therefore
 * completes in a single iteration while the UI receives real tool_call /
 * tool_result parts.
 */

import type { AgentEvent, StreamingChunk } from '../types';
import type { CursorSidecarExecuteResult } from './agent-runner';

export const CURSOR_TOOL_BUDGET_EXHAUSTED_MESSAGE =
  'The model exceeded the maximum number of tool interactions.';

const UNRESOLVED_TOOL_RESULT_MESSAGE = 'The Cursor agent did not report a result for this call.';

/** Tracks tool calls awaiting a result so every call ends with a tool_result. */
export interface CursorAgentTurnMappingState {
  outstandingCalls: Map<string, string>;
  syntheticCallCounter: number;
}

export function createCursorAgentTurnMappingState(): CursorAgentTurnMappingState {
  return { outstandingCalls: new Map(), syntheticCallCounter: 0 };
}

/**
 * Translate one sidecar StreamingChunk into zero or more AgentEvents.
 *
 * Custom-tool calls (RPC-bridged) resolve via a later tool_result chunk;
 * Cursor built-in tool calls carry their result inline, so a synthetic
 * tool_result is emitted immediately after the call events.
 */
export function mapCursorChunkToAgentEvents(
  chunk: StreamingChunk,
  state: CursorAgentTurnMappingState
): AgentEvent[] {
  switch (chunk.type) {
    case 'thinking':
      return chunk.text ? [{ type: 'reasoning_delta', text: chunk.text }] : [];

    case 'text':
      return chunk.text && !chunk.done ? [{ type: 'assistant_text_delta', text: chunk.text }] : [];

    case 'tool_call': {
      const callId = chunk.toolCallId?.trim() || `cursor-call-${++state.syntheticCallCounter}`;
      const name = chunk.name ?? 'tool';
      const events: AgentEvent[] = [
        { type: 'tool_call_started', callId, name },
        {
          type: 'tool_call_completed',
          callId,
          name,
          arguments: JSON.stringify(chunk.args ?? {}),
        },
      ];
      if (chunk.content !== undefined) {
        events.push({
          type: 'tool_result',
          callId,
          name,
          result: chunk.content,
          isError: chunk.isError === true,
        });
      } else {
        state.outstandingCalls.set(callId, name);
      }
      return events;
    }

    case 'tool_result': {
      const callId = chunk.toolCallId?.trim();
      if (!callId) return [];
      const name = chunk.name ?? state.outstandingCalls.get(callId) ?? 'tool';
      state.outstandingCalls.delete(callId);
      return [
        {
          type: 'tool_result',
          callId,
          name,
          result: chunk.content ?? '',
          isError: chunk.isError === true,
        },
      ];
    }

    case 'error':
      return [{ type: 'turn_error', error: chunk.content ?? 'Cursor agent run failed.' }];

    default:
      return [];
  }
}

export interface BudgetedToolExecutor {
  execute: (name: string, args: Record<string, unknown>) => Promise<CursorSidecarExecuteResult>;
  isExhausted: () => boolean;
}

/**
 * Enforces the maxToolIterations budget on the Cursor sidecar's tool RPCs.
 * The SDK loops internally, so the cap applies per tool request: past it,
 * RPCs get an error result and onExhausted fires once (to abort the sidecar).
 */
export function createBudgetedToolExecutor(params: {
  maxToolCalls: number;
  execute: (name: string, args: Record<string, unknown>) => Promise<CursorSidecarExecuteResult>;
  onExhausted: () => void;
}): BudgetedToolExecutor {
  let toolCallCount = 0;
  let exhausted = false;

  return {
    execute: (name, args) => {
      toolCallCount += 1;
      if (toolCallCount > params.maxToolCalls) {
        if (!exhausted) {
          exhausted = true;
          params.onExhausted();
        }
        return Promise.resolve({ error: CURSOR_TOOL_BUDGET_EXHAUSTED_MESSAGE, isError: true });
      }
      return params.execute(name, args);
    },
    isExhausted: () => exhausted,
  };
}

/**
 * Synthesize tool_result events for calls the sidecar never resolved, so the
 * orchestrator does not attempt to re-execute them after turn_completed.
 */
export function flushOutstandingToolResults(state: CursorAgentTurnMappingState): AgentEvent[] {
  const events: AgentEvent[] = Array.from(state.outstandingCalls, ([callId, name]) => ({
    type: 'tool_result',
    callId,
    name,
    result: UNRESOLVED_TOOL_RESULT_MESSAGE,
    isError: true,
  }));
  state.outstandingCalls.clear();
  return events;
}
