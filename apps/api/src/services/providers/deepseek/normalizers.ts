import type { ModelMessage } from 'ai';
import type { TextGenerationRequest } from '../types';

const DEEPSEEK_REASONING_LANGUAGE_INSTRUCTION =
  'When emitting reasoning or thinking content, write it in the same natural language as the current user message unless the user explicitly asks for another language.';

export function buildDeepSeekSystemPrompt(req: TextGenerationRequest): string | undefined {
  const systemPrompt = req.systemPrompt?.trim();
  if (!req.generationConfig?.thinkingEnabled) return systemPrompt || undefined;

  return systemPrompt
    ? `${systemPrompt}\n\n${DEEPSEEK_REASONING_LANGUAGE_INSTRUCTION}`
    : DEEPSEEK_REASONING_LANGUAGE_INSTRUCTION;
}

export function buildDeepSeekMessages(req: TextGenerationRequest): ModelMessage[] {
  return [
    ...req.history.map((message): ModelMessage => {
      if (message.role === 'ai') {
        return { role: 'assistant', content: message.text };
      }
      return { role: 'user', content: message.text };
    }),
    { role: 'user', content: req.prompt },
  ];
}

export function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
