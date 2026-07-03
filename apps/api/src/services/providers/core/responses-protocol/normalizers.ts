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
 * Extracts reasoning text from a completed response payload.
 * Tries summary array first, then falls back to reasoning content array.
 */
export function extractReasoningFromCompleted(response: Responses.Response): string | null {
  const output = response.output ?? [];

  for (const item of output) {
    if (item.type !== 'reasoning') continue;

    // Try summary array first
    if (Array.isArray(item.summary)) {
      const texts = item.summary.filter((s) => s.text).map((s) => s.text);
      if (texts.length > 0) return texts.join('\n\n');
    }

    // Fallback: reasoning content array (not modeled by SDK types)
    const extended = item as ReasoningItemWithContent;
    if (Array.isArray(extended.content)) {
      const texts = extended.content
        .filter(
          (c): c is { type: string; text: string } =>
            c.type === 'reasoning_text' && typeof c.text === 'string'
        )
        .map((c) => c.text);
      if (texts.length > 0) return texts.join('\n\n');
    }
  }

  return null;
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
