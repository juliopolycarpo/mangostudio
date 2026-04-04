/**
 * Canonical replay builder: reconstructs provider-native chat history
 * from persisted ChatTurnContext (with structured parts).
 *
 * Each provider needs its own format:
 * - OpenAI Responses API: input items with role + content, function_call + function_call_output
 * - Gemini Interactions: turns with role user/model, content objects, function_result
 * - OpenAI-compatible (Chat Completions): ChatCompletionMessageParam with tool_calls + tool results
 *
 * Falls back to plain text when no structured parts are available (backward compatible
 * with messages persisted before the parts system existed).
 *
 * Note: thinking parts are excluded from replay — models do not need their own prior
 * reasoning tokens in replay input. Error parts are UI artifacts and are also excluded.
 */

import type OpenAI from 'openai';
import type { ChatTurnContext } from './types';
import type { MessagePart } from '@mangostudio/shared/types';

// ---------------------------------------------------------------------------
// OpenAI Responses API replay
// ---------------------------------------------------------------------------

/**
 * Builds OpenAI Responses API input items from rich history.
 *
 * Structured parts are reconstructed into:
 * - { role: 'user', content: text }
 * - { role: 'assistant', content: text }
 * - { type: 'function_call', call_id, name, arguments }
 * - { type: 'function_call_output', call_id, output }
 *
 * Falls back to plain text when parts are absent.
 */
export function buildOpenAIResponsesReplay(
  history: ChatTurnContext[]
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const turn of history) {
    if (!turn.parts || turn.parts.length === 0) {
      // Fallback: plain text
      items.push({
        role: turn.role === 'ai' ? 'assistant' : 'user',
        content: turn.text,
      });
      continue;
    }

    // User turns always emit plain text — users don't have structured parts
    if (turn.role === 'user') {
      items.push({ role: 'user', content: turn.text });
      continue;
    }

    // AI turn: reconstruct from parts
    const textParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'
    );
    const toolCallParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call'
    );
    const toolResultParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result'
    );

    const textContent = textParts.map((p) => p.text).join('');
    if (textContent) {
      items.push({ role: 'assistant', content: textContent });
    }

    for (const part of toolCallParts) {
      items.push({
        type: 'function_call',
        call_id: part.toolCallId,
        name: part.name,
        arguments: JSON.stringify(part.args),
      });
    }

    for (const part of toolResultParts) {
      items.push({
        type: 'function_call_output',
        call_id: part.toolCallId,
        output: part.content,
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Gemini Interactions API replay
// ---------------------------------------------------------------------------

/**
 * Builds Gemini Interactions-compatible turn array from rich history.
 *
 * Structured parts are reconstructed into:
 * - { role: 'user', content: text }
 * - { role: 'model', content: text }
 * - { role: 'model', content: [{ type: 'function_call', ... }] }  (tool calls)
 * - { role: 'user', content: [{ type: 'function_result', ... }] } (tool results)
 *
 * Falls back to plain text when parts are absent.
 */
export function buildGeminiInteractionsReplay(
  history: ChatTurnContext[]
): Array<Record<string, unknown>> {
  const turns: Array<Record<string, unknown>> = [];

  for (const turn of history) {
    if (!turn.parts || turn.parts.length === 0) {
      if (!turn.text?.trim()) continue;
      turns.push({
        role: turn.role === 'ai' ? 'model' : 'user',
        content: turn.text,
      });
      continue;
    }

    // User turns always emit plain text
    if (turn.role === 'user') {
      if (!turn.text?.trim()) continue;
      turns.push({ role: 'user', content: turn.text });
      continue;
    }

    // AI turn: reconstruct from parts
    const textParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'
    );
    const toolCallParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call'
    );
    const toolResultParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result'
    );

    const textContent = textParts.map((p) => p.text).join('');
    if (textContent) {
      turns.push({ role: 'model', content: textContent });
    }

    if (toolCallParts.length > 0) {
      turns.push({
        role: 'model',
        content: toolCallParts.map((tc) => ({
          type: 'function_call' as const,
          id: tc.toolCallId,
          name: tc.name,
          arguments: tc.args,
        })),
      });
    }

    if (toolResultParts.length > 0) {
      turns.push({
        role: 'user',
        content: toolResultParts.map((tr) => ({
          type: 'function_result' as const,
          call_id: tr.toolCallId,
          name: '',
          result: (() => {
            try {
              return JSON.parse(tr.content);
            } catch {
              return tr.content;
            }
          })(),
          is_error: tr.isError ?? false,
        })),
      });
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (openai-compatible) replay
// ---------------------------------------------------------------------------

/**
 * Builds OpenAI Chat Completions message array from rich history.
 *
 * Structured parts are reconstructed into:
 * - { role: 'user', content }
 * - { role: 'assistant', content, tool_calls? }
 * - { role: 'tool', tool_call_id, content }
 *
 * Falls back to plain text when parts are absent.
 */
export function buildChatCompletionsReplay(
  history: ChatTurnContext[]
): Array<OpenAI.ChatCompletionMessageParam> {
  const messages: Array<OpenAI.ChatCompletionMessageParam> = [];

  for (const turn of history) {
    if (!turn.parts || turn.parts.length === 0) {
      messages.push({
        role: turn.role === 'ai' ? 'assistant' : 'user',
        content: turn.text,
      });
      continue;
    }

    // User turns always emit plain text
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.text });
      continue;
    }

    // AI turn: reconstruct structured assistant message
    const textParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'
    );
    const toolCallParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call'
    );
    const toolResultParts = turn.parts.filter(
      (p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result'
    );

    const textContent = textParts.map((p) => p.text).join('') || null;

    if (toolCallParts.length > 0) {
      messages.push({
        role: 'assistant',
        content: textContent,
        tool_calls: toolCallParts.map((tc) => ({
          id: tc.toolCallId,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      for (const tr of toolResultParts) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.toolCallId,
          content: tr.content,
        });
      }
    } else {
      messages.push({ role: 'assistant', content: textContent ?? turn.text });
    }
  }

  return messages;
}
