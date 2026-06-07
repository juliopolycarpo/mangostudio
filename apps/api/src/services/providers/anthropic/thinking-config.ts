/**
 * Extended-thinking budget resolution for Anthropic Messages requests.
 *
 * Single source of truth for the effort → token-budget mapping shared by the
 * agentic tool loop and the plain text-streaming path.
 */

import type { ReasoningEffort } from '@mangostudio/shared';

export interface AnthropicThinkingConfig {
  type: 'enabled';
  budget_tokens: number;
}

const DEFAULT_BUDGET_TOKENS = 2048;

const BUDGET_TOKENS_BY_EFFORT: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 2048,
  high: 8192,
  xhigh: 8192,
  max: 8192,
};

/**
 * Builds the Anthropic `thinking` config, or undefined when thinking is off.
 */
// Usage: const thinking = buildAnthropicThinkingConfig(true, 'high');
export function buildAnthropicThinkingConfig(
  thinkingEnabled: boolean,
  effort: ReasoningEffort
): AnthropicThinkingConfig | undefined {
  if (!thinkingEnabled) return undefined;
  return {
    type: 'enabled',
    budget_tokens: BUDGET_TOKENS_BY_EFFORT[effort] ?? DEFAULT_BUDGET_TOKENS,
  };
}
