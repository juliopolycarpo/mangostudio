/**
 * Typed narrowing helpers for OpenAI SDK boundaries.
 *
 * Shared between openai-provider (Responses API) and
 * openai-compatible-provider (Chat Completions).
 */

import type { Responses } from 'openai/resources/responses/responses';

// Re-export SDK types used by both provider files
export type ResponseStreamEvent = Responses.ResponseStreamEvent;
export type ResponseCreateParamsStreaming = Responses.ResponseCreateParamsStreaming;

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

    // Fallback: reasoning content array (not always present in SDK types)
    const rec = item as unknown as Record<string, unknown>;
    if (Array.isArray(rec.content)) {
      const texts = (rec.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === 'reasoning_text' && typeof c.text === 'string')
        .map((c) => c.text as string);
      if (texts.length > 0) return texts.join('\n\n');
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reasoning extraction — Chat Completions (openai-compatible endpoints)
// ---------------------------------------------------------------------------

/**
 * Extracts reasoning text from a streaming delta object.
 * Handles three field shapes used across compatible endpoints:
 *   - reasoning_content: DeepSeek native / OpenRouter alias
 *   - reasoning: OpenRouter normalized string
 *   - reasoning_details: OpenRouter structured array (reasoning.text / reasoning.summary)
 *
 * Returns an array of text chunks so callers can emit one event per chunk.
 */
export function extractReasoningChunks(delta: Record<string, unknown>): string[] {
  const chunks: string[] = [];

  const simple =
    (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') ||
    (typeof delta.reasoning === 'string' ? delta.reasoning : '');
  if (simple) chunks.push(simple);

  if (Array.isArray(delta.reasoning_details)) {
    for (const d of delta.reasoning_details as Array<Record<string, unknown>>) {
      if (
        (d.type === 'reasoning.text' || d.type === 'reasoning.summary') &&
        typeof d.text === 'string' &&
        d.text
      ) {
        chunks.push(d.text);
      }
    }
  }

  return chunks;
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
