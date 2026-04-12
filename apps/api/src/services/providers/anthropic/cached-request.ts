/**
 * Builds Anthropic message requests with prompt caching (cache_control: ephemeral).
 *
 * Layout optimised for maximum prefix cache hits:
 *   1. System prompt (static, cached)
 *   2. Tool definitions (static, last item gets cache_control)
 *   3. Previous messages (growing, partial cache possible)
 *   4. New user input (never cached)
 *
 * IMPORTANT: the system prompt must NEVER contain timestamps, dynamic status,
 * or any volatile data — these invalidate the prefix cache on every request.
 * Use tools (e.g. get_current_datetime) for dynamic information instead.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition } from '../types';

export interface BuildCachedRequestOpts {
  systemPrompt: string;
  toolDefinitions: ToolDefinition[];
  messages: Anthropic.MessageParam[];
  thinkingConfig?: { type: 'enabled'; budget_tokens: number };
}

type CacheControl = { type: 'ephemeral' };
const EPHEMERAL: CacheControl = { type: 'ephemeral' };

export function buildCachedAnthropicRequest(opts: BuildCachedRequestOpts): {
  system: Anthropic.MessageCreateParams['system'];
  tools: Anthropic.MessageCreateParams['tools'];
  messages: Anthropic.MessageParam[];
  max_tokens: number;
  thinking?: { type: 'enabled'; budget_tokens: number };
} {
  // System prompt with cache_control on the block
  const system: Anthropic.MessageCreateParams['system'] = opts.systemPrompt.trim()
    ? [
        {
          type: 'text' as const,
          text: opts.systemPrompt,
          cache_control: EPHEMERAL,
        },
      ]
    : undefined;

  // Tools with cache_control on the LAST item only (maximises prefix match)
  const tools: Anthropic.MessageCreateParams['tools'] =
    opts.toolDefinitions.length > 0
      ? opts.toolDefinitions.map((t, i, arr) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool['input_schema'],
          ...(i === arr.length - 1 ? { cache_control: EPHEMERAL } : {}),
        }))
      : undefined;

  const maxTokens = opts.thinkingConfig ? 16000 : 8192;

  return {
    system,
    tools,
    messages: opts.messages,
    max_tokens: maxTokens,
    ...(opts.thinkingConfig ? { thinking: opts.thinkingConfig } : {}),
  };
}
