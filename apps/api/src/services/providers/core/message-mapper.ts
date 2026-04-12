/**
 * Shared message mapping helpers.
 *
 * Provides role-normalisation and system-prompt construction utilities
 * used across provider adapters. Provider-specific format conversions
 * live in each provider's own message-mapper.
 */

import type { TextContextMessage } from '../types';

/**
 * Maps the internal 'ai' role to the provider-facing 'assistant' role.
 * All providers use 'user' and 'assistant'; our internal model uses 'user' and 'ai'.
 */
export function toProviderRole(role: 'user' | 'ai'): 'user' | 'assistant' {
  return role === 'ai' ? 'assistant' : 'user';
}

/**
 * Returns the system prompt as a trimmed string, or undefined if empty.
 * Prevents sending empty system prompts that consume tokens needlessly.
 */
export function normalizeSystemPrompt(systemPrompt: string | undefined): string | undefined {
  const trimmed = systemPrompt?.trim();
  return trimmed || undefined;
}

/**
 * Converts a flat TextContextMessage array to { role, content } pairs
 * suitable for any OpenAI-style chat completions endpoint.
 */
export function textHistoryToMessages(
  history: TextContextMessage[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.map((msg) => ({
    role: toProviderRole(msg.role),
    content: msg.text,
  }));
}
