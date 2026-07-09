import type { DeepSeekLanguageModelOptions } from '@ai-sdk/deepseek';
import type { ReasoningEffort } from '@mangostudio/shared/types';
import type { ModelMessage } from 'ai';
import { appendAttachmentFallbackNotes } from '../core/attachment-content';
import type { TextGenerationRequest } from '../types';

/**
 * Maps Mango's `ReasoningEffort` to values accepted by the DeepSeek API.
 *
 * DeepSeek thinking effort accepts: `high`, `xhigh`, `max`.
 * - `low` maps to `high` (minimum viable reasoning)
 * - `medium` maps to `high`
 * - `high` stays `high`
 * - `xhigh` maps to `max`
 * - `max` stays `max`
 */
export function normalizeDeepSeekReasoningEffort(
  effort: ReasoningEffort
): DeepSeekLanguageModelOptions['reasoningEffort'] {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
      return 'high';
    case 'xhigh':
      return 'max';
    case 'max':
      return 'max';
  }
}

const DEEPSEEK_REASONING_LANGUAGE_INSTRUCTION =
  'When emitting reasoning or thinking content, write it in the same natural language as the current user message unless the user explicitly asks for another language.';

export function buildDeepSeekSystemPrompt(req: TextGenerationRequest): string | undefined {
  const systemPrompt = req.systemPrompt?.trim();
  if (!req.generationConfig?.thinkingEnabled) return systemPrompt || undefined;

  return systemPrompt
    ? `${systemPrompt}\n\n${DEEPSEEK_REASONING_LANGUAGE_INSTRUCTION}`
    : DEEPSEEK_REASONING_LANGUAGE_INSTRUCTION;
}

export function buildDeepSeekChatMessages(req: TextGenerationRequest): ModelMessage[] {
  const prompt = appendAttachmentFallbackNotes(req.prompt, req.attachments, req.modelCapabilities);

  return [
    ...req.history.map((message): ModelMessage => {
      if (message.role === 'ai') {
        return { role: 'assistant', content: message.text };
      }
      return { role: 'user', content: message.text };
    }),
    { role: 'user', content: prompt },
  ];
}

export function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
