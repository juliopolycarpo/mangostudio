/**
 * Typed narrowing helpers for Google GenAI Interactions SDK boundaries.
 *
 * Accepts streaming events from the Interactions API and provides
 * well-typed accessors so the provider file stays free of unsafe casts.
 */
import type { Interactions } from '@google/genai';

type ContentStart = Interactions.ContentStart;
type ContentDelta = Interactions.ContentDelta;
type FunctionCallContent = Interactions.FunctionCallContent;
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
// Content-start narrowing
// ---------------------------------------------------------------------------

/** Check whether a content.start event carries a function_call block. */
export function isFunctionCallStart(
  content: ContentStart['content']
): content is FunctionCallContent {
  return content.type === 'function_call';
}

// ---------------------------------------------------------------------------
// Content-delta narrowing
// ---------------------------------------------------------------------------

export type NarrowedGeminiDelta =
  | { kind: 'thought_summary'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'function_call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'thought_signature' }
  | { kind: 'other' };

/** Narrow a ContentDelta's delta union into a simple discriminated shape. */
export function narrowGeminiDelta(delta: ContentDelta['delta']): NarrowedGeminiDelta {
  switch (delta.type) {
    case 'thought_summary': {
      const text = delta.content && 'text' in delta.content ? delta.content.text : '';
      return { kind: 'thought_summary', text };
    }
    case 'text':
      return { kind: 'text', text: delta.text };
    case 'function_call':
      return {
        kind: 'function_call',
        id: delta.id,
        name: delta.name,
        args: delta.arguments,
      };
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
