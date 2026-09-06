/**
 * Maps raw Gemini Interactions SSE events into canonical AgentEvents.
 *
 * Owns the per-turn function-call bookkeeping (calls keyed by stream index,
 * whose JSON arguments arrive as string fragments across step deltas) and
 * captures the terminal interaction id and reported usage used to mint the
 * continuation envelope. Owns its diagnostic logging for cache hits and
 * unrecognised delta shapes.
 */

import { createDiagnosticLogger } from '../../../lib/logger';
import type { AgentEvent } from '../types';
import {
  extractGeminiUsage,
  hasInlineStepContent,
  type InteractionSSEEvent,
  isFunctionCallStart,
  narrowGeminiDelta,
} from './normalizers';

const geminiInteractionsLogger = createDiagnosticLogger('gemini-interactions');

interface ActiveCall {
  id: string;
  name: string;
  /** JSON text assembled from `arguments_delta` fragments. */
  argumentsJson: string;
  /** Arguments already present on the opening `step.start`. */
  initialArguments: Record<string, unknown>;
}

type ActiveCalls = Map<number, ActiveCall>;

export interface GeminiInteractionAccumulator {
  /** Maps one raw Interactions SSE event into zero or more AgentEvents. */
  mapEvent(event: InteractionSSEEvent): AgentEvent[];
  /** Interaction id captured from `interaction.created` / `interaction.completed`. */
  readonly interactionId: string | undefined;
  /** Provider-reported input tokens captured from `interaction.completed`. */
  readonly providerReportedInputTokens: number | undefined;
}

/** Builds an accumulator for a single Gemini Interactions stream. */
// Usage: const accumulator = createGeminiInteractionAccumulator();
export function createGeminiInteractionAccumulator(): GeminiInteractionAccumulator {
  const activeCalls: ActiveCalls = new Map();
  let interactionId: string | undefined;
  let providerReportedInputTokens: number | undefined;

  const captureUsage = (
    event: Extract<InteractionSSEEvent, { event_type: 'interaction.completed' }>
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
        case 'step.start':
          return mapStepStart(event, activeCalls);
        case 'step.delta':
          return mapStepDelta(event, activeCalls);
        case 'step.stop':
          return mapStepStop(event, activeCalls);
        case 'interaction.completed':
          captureUsage(event);
          return [];
        case 'interaction.created':
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

type StepStartEvent = Extract<InteractionSSEEvent, { event_type: 'step.start' }>;
type StepDeltaEvent = Extract<InteractionSSEEvent, { event_type: 'step.delta' }>;
type StepStopEvent = Extract<InteractionSSEEvent, { event_type: 'step.stop' }>;

function mapStepStart(event: StepStartEvent, activeCalls: ActiveCalls): AgentEvent[] {
  if (!isFunctionCallStart(event.step)) {
    // Assistant text and thought summaries are rendered from step.delta only.
    // A pre-populated step means the deltas are not coming — surface it rather
    // than silently dropping a turn's visible output.
    if (hasInlineStepContent(event.step)) {
      geminiInteractionsLogger.warn('inline_step_content', {
        index: event.index,
        stepType: event.step.type,
      });
    }
    return [];
  }

  const callId = event.step.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const name = event.step.name;
  const call: ActiveCall = {
    id: callId,
    name,
    argumentsJson: '',
    initialArguments: event.step.arguments ?? {},
  };
  activeCalls.set(event.index, call);

  // v2 makes `name` required on FunctionCallStep and no longer repeats it in
  // the deltas, so a nameless call can never be started later — track it so
  // its arguments still land, but keep it off the wire.
  if (!name) return [];
  return [{ type: 'tool_call_started', callId, name }];
}

function mapStepDelta(event: StepDeltaEvent, activeCalls: ActiveCalls): AgentEvent[] {
  const delta = narrowGeminiDelta(event.delta);
  if (delta.kind === 'thought_summary') {
    return delta.text ? [{ type: 'reasoning_delta', text: delta.text }] : [];
  }
  if (delta.kind === 'text') {
    return [{ type: 'assistant_text_delta', text: delta.text }];
  }
  if (delta.kind === 'arguments_delta') {
    return mapArgumentsDelta(event.index, delta.arguments, activeCalls);
  }
  if (delta.kind !== 'thought_signature') {
    geminiInteractionsLogger.warn('unknown_delta_type', { delta: event.delta });
  }
  return [];
}

function mapArgumentsDelta(
  index: number,
  fragment: string,
  activeCalls: ActiveCalls
): AgentEvent[] {
  const call = activeCalls.get(index);
  if (!call || !fragment) return [];

  call.argumentsJson += fragment;
  return [{ type: 'tool_call_arguments_delta', callId: call.id, delta: fragment }];
}

/**
 * Resolves the call's final argument JSON.
 *
 * `step.stop` carries no payload, so the arguments are whatever the
 * `arguments_delta` fragments assembled. A call whose arguments were sent
 * whole on `step.start` streams no fragments at all, and a truncated stream
 * leaves an unparsable buffer; both fall back to the opening arguments.
 */
function resolveCallArguments(call: ActiveCall): string {
  const buffered = call.argumentsJson.trim();
  if (!buffered) return JSON.stringify(call.initialArguments);

  try {
    JSON.parse(buffered);
    return buffered;
  } catch {
    geminiInteractionsLogger.warn('unparsable_arguments_delta', {
      callId: call.id,
      name: call.name,
      buffered,
    });
    return JSON.stringify(call.initialArguments);
  }
}

function mapStepStop(event: StepStopEvent, activeCalls: ActiveCalls): AgentEvent[] {
  const call = activeCalls.get(event.index);
  if (!call) return [];
  activeCalls.delete(event.index);
  return [
    {
      type: 'tool_call_completed',
      callId: call.id,
      name: call.name,
      arguments: resolveCallArguments(call),
    },
  ];
}
