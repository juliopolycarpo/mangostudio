/**
 * Maps raw Gemini Interactions SSE events into canonical AgentEvents.
 *
 * Owns the per-turn function-call bookkeeping (calls keyed by stream index,
 * whose name and arguments may arrive incrementally across content deltas) and
 * captures the terminal interaction id and reported usage used to mint the
 * continuation envelope. Owns its diagnostic logging for cache hits and
 * unrecognised delta shapes.
 */

import { createDiagnosticLogger } from '../../../lib/logger';
import type { AgentEvent } from '../types';
import {
  extractGeminiUsage,
  type InteractionSSEEvent,
  isFunctionCallStart,
  narrowGeminiDelta,
} from './normalizers';

const geminiInteractionsLogger = createDiagnosticLogger('gemini-interactions');

interface ActiveCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  started: boolean;
}

type ActiveCalls = Map<number, ActiveCall>;

export interface GeminiInteractionAccumulator {
  /** Maps one raw Interactions SSE event into zero or more AgentEvents. */
  mapEvent(event: InteractionSSEEvent): AgentEvent[];
  /** Interaction id captured from `interaction.start` / `interaction.complete`. */
  readonly interactionId: string | undefined;
  /** Provider-reported input tokens captured from `interaction.complete`. */
  readonly providerReportedInputTokens: number | undefined;
}

/** Builds an accumulator for a single Gemini Interactions stream. */
// Usage: const accumulator = createGeminiInteractionAccumulator();
export function createGeminiInteractionAccumulator(): GeminiInteractionAccumulator {
  const activeCalls: ActiveCalls = new Map();
  let interactionId: string | undefined;
  let providerReportedInputTokens: number | undefined;

  const captureUsage = (
    event: Extract<InteractionSSEEvent, { event_type: 'interaction.complete' }>
  ) => {
    interactionId = event.interaction.id;
    const usage = extractGeminiUsage(event.interaction.usage);
    if (usage.totalInputTokens > 0) providerReportedInputTokens = usage.totalInputTokens;
    if (usage.cachedTokens > 0 && usage.totalInputTokens > 0) {
      geminiInteractionsLogger.info('prefix_cache_hit', {
        cachedTokens: usage.cachedTokens,
        totalInputTokens: usage.totalInputTokens,
        hitPercent: Math.round((usage.cachedTokens / usage.totalInputTokens) * 100),
      });
    }
  };

  return {
    mapEvent(event) {
      switch (event.event_type) {
        case 'content.start':
          return mapContentStart(event, activeCalls);
        case 'content.delta':
          return mapContentDelta(event, activeCalls);
        case 'content.stop':
          return mapContentStop(event, activeCalls);
        case 'interaction.complete':
          captureUsage(event);
          return [];
        case 'interaction.start':
          interactionId = event.interaction.id;
          return [];
        default:
          return [];
      }
    },
    get interactionId() {
      return interactionId;
    },
    get providerReportedInputTokens() {
      return providerReportedInputTokens;
    },
  };
}

type ContentStartEvent = Extract<InteractionSSEEvent, { event_type: 'content.start' }>;
type ContentDeltaEvent = Extract<InteractionSSEEvent, { event_type: 'content.delta' }>;
type ContentStopEvent = Extract<InteractionSSEEvent, { event_type: 'content.stop' }>;

function mapContentStart(event: ContentStartEvent, activeCalls: ActiveCalls): AgentEvent[] {
  if (!isFunctionCallStart(event.content)) return [];
  const callId = event.content.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const name = event.content.name;
  const call: ActiveCall = { id: callId, name, args: {}, started: false };
  activeCalls.set(event.index, call);

  if (!name) return [];
  call.started = true;
  return [{ type: 'tool_call_started', callId, name }];
}

function mapContentDelta(event: ContentDeltaEvent, activeCalls: ActiveCalls): AgentEvent[] {
  const delta = narrowGeminiDelta(event.delta);
  if (delta.kind === 'thought_summary') {
    return delta.text ? [{ type: 'reasoning_delta', text: delta.text }] : [];
  }
  if (delta.kind === 'text') {
    return [{ type: 'assistant_text_delta', text: delta.text }];
  }
  if (delta.kind === 'function_call') {
    return mapFunctionCallDelta(event.index, delta, activeCalls);
  }
  if (delta.kind !== 'thought_signature') {
    geminiInteractionsLogger.warn('unknown_delta_type', { delta: event.delta });
  }
  return [];
}

function mapFunctionCallDelta(
  index: number,
  delta: Extract<ReturnType<typeof narrowGeminiDelta>, { kind: 'function_call' }>,
  activeCalls: ActiveCalls
): AgentEvent[] {
  const call = activeCalls.get(index);
  if (!call) return [];

  const events: AgentEvent[] = [];
  if (delta.name && !call.name) call.name = delta.name;
  if (!call.started && call.name) {
    call.started = true;
    events.push({ type: 'tool_call_started', callId: call.id, name: call.name });
  }
  Object.assign(call.args, delta.args);
  events.push({
    type: 'tool_call_arguments_delta',
    callId: call.id,
    delta: JSON.stringify(delta.args),
  });
  return events;
}

function mapContentStop(event: ContentStopEvent, activeCalls: ActiveCalls): AgentEvent[] {
  const call = activeCalls.get(event.index);
  if (!call) return [];
  activeCalls.delete(event.index);
  return [
    {
      type: 'tool_call_completed',
      callId: call.id,
      name: call.name,
      arguments: JSON.stringify(call.args),
    },
  ];
}
