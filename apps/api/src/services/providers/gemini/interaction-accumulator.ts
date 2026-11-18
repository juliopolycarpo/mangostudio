/**
 * Maps raw Gemini Interactions SSE events into canonical AgentEvents.
 *
 * Owns the per-turn function-call bookkeeping (calls keyed by stream index,
 * whose JSON arguments arrive as string fragments across step deltas) and
 * captures the terminal interaction id, reported usage, and final status used
 * to decide whether a continuation envelope may be minted at all. Owns its
 * diagnostic logging for cache hits and unrecognised step and delta shapes.
 */

import { createDiagnosticLogger, type DiagnosticLogger } from '../../../lib/logger';
import { safeJsonParse } from '../../../lib/safe-parse';
import type { AgentEvent } from '../types';
import {
  describeAbandonedInteraction,
  extractGeminiUsage,
  extractInlineStepText,
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

/** Reports a step or delta kind the adapter does not map, at most once per kind per turn. */
interface UnmappedKindReporter {
  step(stepType: string): void;
  delta(deltaType: string): void;
}

/**
 * Builds the per-turn reporter for unmapped kinds. A stream that sends a kind we
 * drop sends it many times (every chunk of a media or annotation delta), so the
 * first sighting warns and the rest stay quiet. Only the kind name is logged:
 * the step or delta body can carry user text, tool output, or media bytes.
 *
 * Usage: const unmapped = createUnmappedKindReporter(logger);
 *        unmapped.step('google_search_call'); // warns
 *        unmapped.step('google_search_call'); // silent
 */
function createUnmappedKindReporter(logger: DiagnosticLogger): UnmappedKindReporter {
  const reported = new Set<string>();
  const reportOnce = (scope: 'step' | 'delta', event: string, kind: string) => {
    const key = `${scope}:${kind}`;
    if (reported.has(key)) return;
    reported.add(key);
    logger.warn(event, scope === 'step' ? { stepType: kind } : { deltaType: kind });
  };
  return {
    step: (stepType) => reportOnce('step', 'unhandled_step_type', stepType),
    delta: (deltaType) => reportOnce('delta', 'unknown_delta_type', deltaType),
  };
}

export interface GeminiInteractionAccumulator {
  /** Maps one raw Interactions SSE event into zero or more AgentEvents. */
  mapEvent(event: InteractionSSEEvent): AgentEvent[];
  /** Interaction id captured from `interaction.created` / `interaction.completed`. */
  readonly interactionId: string | undefined;
  /** Provider-reported input tokens captured from `interaction.completed`. */
  readonly providerReportedInputTokens: number | undefined;
  /**
   * Why the turn must not succeed: an explicit SSE error (terminal), or a final
   * status the interaction cannot be continued from.
   */
  readonly abandonedReason: string | undefined;
}

/**
 * Builds an accumulator for a single Gemini Interactions stream. `logger` is a
 * test seam; production uses the shared `gemini-interactions` diagnostic logger.
 */
// Usage: const accumulator = createGeminiInteractionAccumulator();
export function createGeminiInteractionAccumulator(
  logger: DiagnosticLogger = geminiInteractionsLogger
): GeminiInteractionAccumulator {
  const activeCalls: ActiveCalls = new Map();
  const unmapped = createUnmappedKindReporter(logger);
  let interactionId: string | undefined;
  let providerReportedInputTokens: number | undefined;
  let abandonedReason: string | undefined;
  let streamError: string | undefined;

  // Last status wins: every lifecycle event carries the interaction's status,
  // so the one the stream ends on is the one that decides the turn.
  const noteStatus = (status: string) => {
    abandonedReason = describeAbandonedInteraction(status);
  };

  const captureUsage = (
    event: Extract<InteractionSSEEvent, { event_type: 'interaction.completed' }>
  ) => {
    interactionId = event.interaction.id;
    const usage = extractGeminiUsage(event.interaction.usage);
    if (usage.totalInputTokens > 0) providerReportedInputTokens = usage.totalInputTokens;
    if (usage.cachedTokens > 0 && usage.totalInputTokens > 0) {
      logger.info('prefix_cache_hit', {
        cachedTokens: usage.cachedTokens,
        totalInputTokens: usage.totalInputTokens,
        hitPercent: Math.round((usage.cachedTokens / usage.totalInputTokens) * 100),
      });
    }
  };

  return {
    mapEvent(event) {
      if (streamError) return [];

      switch (event.event_type) {
        case 'error': {
          const code = event.error?.code;
          const message = event.error?.message;
          streamError = [code, message].filter(Boolean).join(': ') || 'Gemini interaction failed.';
          logger.error('interaction_error', { code, message });
          return [];
        }
        case 'step.start':
          return mapStepStart(event, activeCalls, unmapped);
        case 'step.delta':
          return mapStepDelta(event, activeCalls, logger, unmapped);
        case 'step.stop':
          return mapStepStop(event, activeCalls, logger);
        case 'interaction.completed':
          noteStatus(event.interaction.status);
          captureUsage(event);
          return [];
        case 'interaction.created':
          noteStatus(event.interaction.status);
          interactionId = event.interaction.id;
          return [];
        case 'interaction.status_update':
          noteStatus(event.status);
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
    get abandonedReason() {
      return streamError ?? abandonedReason;
    },
  };
}

type StepStartEvent = Extract<InteractionSSEEvent, { event_type: 'step.start' }>;
type StepDeltaEvent = Extract<InteractionSSEEvent, { event_type: 'step.delta' }>;
type StepStopEvent = Extract<InteractionSSEEvent, { event_type: 'step.stop' }>;

function mapStepStart(
  event: StepStartEvent,
  activeCalls: ActiveCalls,
  unmapped: UnmappedKindReporter
): AgentEvent[] {
  if (!isFunctionCallStart(event.step)) {
    // Only `model_output` and `thought` are mapped. Any other kind (server-side
    // tool steps, ...) is dropped, so say so: without this a step we do not
    // understand reads as a turn that silently produced nothing.
    if (event.step.type !== 'model_output' && event.step.type !== 'thought') {
      unmapped.step(event.step.type);
      return [];
    }
    // A `model_output` / `thought` step.start can open with the turn's first
    // chunk already attached; step.delta continues it rather than repeating
    // it, so this text is a prefix to render, not a duplicate to drop.
    const text = extractInlineStepText(event.step);
    if (!text) return [];
    return event.step.type === 'thought'
      ? [{ type: 'reasoning_delta', text }]
      : [{ type: 'assistant_text_delta', text }];
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
  // the deltas, so a nameless call can never be named later. Announce it
  // anyway: `tool_call_started` is what opens the consumer's pending-call
  // entry, and without it every `arguments_delta` for this call is dropped
  // while `step.stop` still completes it. `name` is optional on the event for
  // exactly this case — the same shape the chat-completions accumulator uses.
  return [{ type: 'tool_call_started', callId, name: name || undefined }];
}

function mapStepDelta(
  event: StepDeltaEvent,
  activeCalls: ActiveCalls,
  logger: DiagnosticLogger,
  unmapped: UnmappedKindReporter
): AgentEvent[] {
  const delta = narrowGeminiDelta(event.delta);
  if (delta.kind === 'thought_summary') {
    return delta.text ? [{ type: 'reasoning_delta', text: delta.text }] : [];
  }
  if (delta.kind === 'text') {
    return [{ type: 'assistant_text_delta', text: delta.text }];
  }
  if (delta.kind === 'arguments_delta') {
    return mapArgumentsDelta(event.index, delta.arguments, activeCalls, logger);
  }
  if (delta.kind !== 'thought_signature') {
    // Name the kind only: annotation and media deltas carry citations, text and bytes.
    unmapped.delta(event.delta.type);
  }
  return [];
}

function mapArgumentsDelta(
  index: number,
  fragment: string,
  activeCalls: ActiveCalls,
  logger: DiagnosticLogger
): AgentEvent[] {
  const call = activeCalls.get(index);
  if (!call) {
    // v2 moved every argument byte into the deltas, so an unmatched fragment
    // is a whole tool call lost rather than a partial update missed.
    logger.warn('orphan_arguments_delta', { index });
    return [];
  }
  if (!fragment) return [];

  call.argumentsJson += fragment;
  return [{ type: 'tool_call_arguments_delta', callId: call.id, delta: fragment }];
}

/** Cap on the argument text echoed into a diagnostic; calls carry file bodies. */
const ARGUMENTS_DIAGNOSTIC_PREVIEW_CHARS = 200;

/**
 * Resolves the call's final argument JSON.
 *
 * `step.stop` carries no payload, so the arguments are whatever the
 * `arguments_delta` fragments assembled. A call whose arguments were sent
 * whole on `step.start` streams no fragments at all, and a truncated stream
 * leaves an unusable buffer; both fall back to the opening arguments.
 *
 * The buffer is validated with `safeJsonParse` rather than a bare `JSON.parse`
 * so it has to be a JSON *object*: a fragment stream that reassembles into an
 * array, a bare string or `null` parses fine but is not an argument map, and
 * passing it on would drop the `step.start` fallback for a `{}` the consumer
 * silently substitutes downstream.
 *
 * Usage: resolveCallArguments({ id: 'fc_1', name: 'search', argumentsJson: '{"q":1}', initialArguments: {} }, logger)
 *        -> '{"q":1}'
 */
function resolveCallArguments(call: ActiveCall, logger: DiagnosticLogger): string {
  const buffered = call.argumentsJson.trim();
  if (!buffered) return JSON.stringify(call.initialArguments);
  if (safeJsonParse(buffered)) return buffered;

  logger.warn('unusable_arguments_delta', {
    callId: call.id,
    name: call.name,
    bufferedChars: buffered.length,
    bufferedPreview: buffered.slice(0, ARGUMENTS_DIAGNOSTIC_PREVIEW_CHARS),
  });
  return JSON.stringify(call.initialArguments);
}

function mapStepStop(
  event: StepStopEvent,
  activeCalls: ActiveCalls,
  logger: DiagnosticLogger
): AgentEvent[] {
  const call = activeCalls.get(event.index);
  if (!call) return [];
  activeCalls.delete(event.index);
  return [
    {
      type: 'tool_call_completed',
      callId: call.id,
      name: call.name,
      arguments: resolveCallArguments(call, logger),
    },
  ];
}
