import type { ModelMessage } from 'ai';
import type { TextGenerationRequest } from '../types';

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
