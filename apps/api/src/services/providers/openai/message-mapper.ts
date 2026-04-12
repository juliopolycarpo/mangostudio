/**
 * OpenAI-format message builders.
 * Converts internal request shapes into OpenAI Chat Completions and Responses API inputs.
 */

import type OpenAI from 'openai';
import type { TextGenerationRequest } from '../types';

/**
 * Builds a Chat Completions messages array from a TextGenerationRequest.
 * Prepends system prompt when present; maps history + prompt.
 */
export function buildChatMessages(req: TextGenerationRequest): OpenAI.ChatCompletionMessageParam[] {
  return [
    ...(req.systemPrompt?.trim() ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
    ...req.history.map(
      (msg): OpenAI.ChatCompletionMessageParam => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.text,
      })
    ),
    { role: 'user' as const, content: req.prompt },
  ];
}

/**
 * Builds the `input` array for the Responses API from a TextGenerationRequest.
 * Maps history + current prompt into the shape expected by responses.create().
 */
export function buildResponsesInput(
  req: TextGenerationRequest
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  for (const msg of req.history) {
    messages.push({
      role: msg.role === 'ai' ? 'assistant' : 'user',
      content: msg.text,
    });
  }

  messages.push({ role: 'user', content: req.prompt });
  return messages;
}
