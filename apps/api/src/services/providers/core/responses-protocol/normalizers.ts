/**
 * Typed narrowing helpers for the Responses protocol stream.
 */

import type { Responses } from 'openai/resources/responses/responses';

export type ResponseStreamEvent = Responses.ResponseStreamEvent;

// ---------------------------------------------------------------------------
// SDK type gaps
//
// The OpenAI SDK sometimes omits fields that appear on the wire.
// These interfaces cover the gaps so the casts have documented targets.
// ---------------------------------------------------------------------------

/** Reasoning output item with the `content` array that the SDK type omits. */
interface ReasoningItemWithContent {
  type: 'reasoning';
  summary?: Array<{ text: string }>;
  content?: Array<{ type: string; text?: string }>;
}

// ---------------------------------------------------------------------------
// Reasoning extraction — Responses API (response.completed fallback)
// ---------------------------------------------------------------------------

/**
 * Extracts reasoning text from a completed response payload, across every reasoning item.
 * Uses the summary parts when any item has them, otherwise the raw reasoning content parts.
 * Parts are joined with a blank line, as the stream tracker does: the two must read the same.
 */
export function extractReasoningFromCompleted(response: Responses.Response): string | null {
  const reasoningItems = (response.output ?? []).filter((item) => item.type === 'reasoning');

  const summaryParts = reasoningItems.flatMap((item) =>
    Array.isArray(item.summary) ? item.summary.filter((s) => s.text).map((s) => s.text) : []
  );
  if (summaryParts.length > 0) return summaryParts.join('\n\n');

  // Fallback: reasoning content array (not modeled by SDK types)
  const contentParts = reasoningItems.flatMap((item) => {
    const extended = item as ReasoningItemWithContent;
    if (!Array.isArray(extended.content)) return [];
    return extended.content
      .filter(
        (c): c is { type: string; text: string } =>
          c.type === 'reasoning_text' && typeof c.text === 'string'
      )
      .map((c) => c.text);
  });
  return contentParts.length > 0 ? contentParts.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// Usage extraction — Responses API
// ---------------------------------------------------------------------------

export interface ResponsesUsage {
  inputTokens: number | undefined;
}

/** Extract input token count from a completed response's usage. */
export function extractResponsesUsage(response: Responses.Response): ResponsesUsage {
  const usage = response.usage;
  if (!usage) return { inputTokens: undefined };
  return {
    inputTokens:
      typeof usage.input_tokens === 'number' && usage.input_tokens > 0
        ? usage.input_tokens
        : undefined,
  };
}
