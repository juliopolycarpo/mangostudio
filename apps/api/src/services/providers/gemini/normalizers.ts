/**
 * Typed narrowing helpers for Google GenAI Interactions SDK boundaries.
 *
 * Accepts streaming events from the Interactions API and provides
 * well-typed accessors so the provider file stays free of unsafe casts.
 */
import type { Interactions } from '@google/genai';

type StepStart = Interactions.StepStart;
type StepDelta = Interactions.StepDelta;
type FunctionCallStep = Interactions.FunctionCallStep;
export type InteractionSSEEvent = Interactions.InteractionSSEEvent;
type GeminiUsage = Interactions.Usage;
type CreateModelInteractionParamsStreaming = Interactions.CreateModelInteractionParamsStreaming;

// ---------------------------------------------------------------------------
// SDK boundary cast — Gemini Interactions API
//
// The Interactions SDK's CreateModelInteractionParamsStreaming type is strict
// about its property shapes, but our builder constructs params dynamically
// (optional tools, thinking config, history replay). This wrapper contains
// the single cast.
// ---------------------------------------------------------------------------

export function toInteractionParams(
  params: Record<string, unknown>
): CreateModelInteractionParamsStreaming {
  return params as unknown as CreateModelInteractionParamsStreaming;
}

// ---------------------------------------------------------------------------
// Step-start narrowing
// ---------------------------------------------------------------------------

/** Check whether a step.start event opens a function_call step. */
export function isFunctionCallStart(step: StepStart['step']): step is FunctionCallStep {
  return step.type === 'function_call';
}

/**
 * Check whether a step.start event already carries model-visible content.
 *
 * A streaming turn delivers assistant text and thought summaries through
 * step.delta, so a `model_output` / `thought` step that arrives already
 * populated means the server switched to whole-step delivery and the deltas
 * this accumulator renders from are not coming. Callers use this to raise a
 * diagnostic, not to render — emitting here too would double every token in
 * the normal streaming case.
 *
 * Usage: hasInlineStepContent({ type: 'model_output', content: [{ type: 'text', text: 'Hi' }] })
 *        -> true
 */
export function hasInlineStepContent(step: StepStart['step']): boolean {
  if (step.type === 'model_output') return (step.content?.length ?? 0) > 0;
  if (step.type === 'thought') return (step.summary?.length ?? 0) > 0;
  return false;
}

// ---------------------------------------------------------------------------
// Interaction status narrowing
// ---------------------------------------------------------------------------

/**
 * Interaction statuses that end a turn with no usable result, and the reason to
 * report for each.
 *
 * Deliberately narrow. `incomplete` is absent because the API defines it as
 * "completed, but contains incomplete results (e.g. hitting max_tokens)" — the
 * output is real and the interaction is still chainable. `requires_action` is
 * absent because it is the ordinary terminal status of a turn that called a
 * tool and is waiting for its result. `budget_exceeded` is present because it
 * only ever arrives on `interaction.status_update`, never on
 * `interaction.completed`: the API halted the interaction rather than finishing
 * it.
 */
const ABANDONED_INTERACTION_REASONS = new Map<string, string>([
  ['budget_exceeded', 'Gemini halted the interaction: the token budget was exceeded.'],
  ['cancelled', 'Gemini cancelled the interaction before it produced a result.'],
  ['failed', 'Gemini reported that the interaction failed.'],
]);

/**
 * Describe an interaction status that the turn must not treat as a success.
 *
 * Returns the reason to report, or `undefined` for any status the interaction
 * can still be continued from.
 *
 * Usage: describeAbandonedInteraction('failed')
 *        -> 'Gemini reported that the interaction failed.'
 */
export function describeAbandonedInteraction(status: string): string | undefined {
  return ABANDONED_INTERACTION_REASONS.get(status);
}

// ---------------------------------------------------------------------------
// Step-delta narrowing
// ---------------------------------------------------------------------------

export type NarrowedGeminiDelta =
  | { kind: 'thought_summary'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'arguments_delta'; arguments: string }
  | { kind: 'thought_signature' }
  | { kind: 'other' };

/** Narrow a StepDelta's delta union into a simple discriminated shape. */
export function narrowGeminiDelta(delta: StepDelta['delta']): NarrowedGeminiDelta {
  switch (delta.type) {
    case 'thought_summary': {
      const text = delta.content && 'text' in delta.content ? delta.content.text : '';
      return { kind: 'thought_summary', text };
    }
    case 'text':
      return { kind: 'text', text: delta.text };
    case 'arguments_delta':
      return { kind: 'arguments_delta', arguments: delta.arguments ?? '' };
    case 'thought_signature':
      return { kind: 'thought_signature' };
    default:
      return { kind: 'other' };
  }
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

export interface GeminiCacheUsageResult {
  cachedTokens: number;
  totalInputTokens: number;
}

/** Extract cache-aware usage stats from a Gemini Interaction. */
export function extractGeminiUsage(usage: GeminiUsage | undefined): GeminiCacheUsageResult {
  return {
    cachedTokens: usage?.total_cached_tokens ?? 0,
    totalInputTokens: usage?.total_input_tokens ?? 0,
  };
}
