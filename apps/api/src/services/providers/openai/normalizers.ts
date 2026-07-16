/**
 * Typed narrowing helpers for OpenAI SDK boundaries.
 *
 * Responses protocol helpers live in core/responses-protocol. This module keeps
 * OpenAI adapter imports stable and owns Chat Completions reasoning extraction
 * shared with compatible endpoints.
 */

export {
  extractReasoningFromCompleted,
  extractResponsesUsage,
  type ResponseStreamEvent,
} from '../core/responses-protocol/normalizers';

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
