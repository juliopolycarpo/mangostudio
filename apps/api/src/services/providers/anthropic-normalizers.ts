/**
 * Typed narrowing helpers for Anthropic SDK boundaries.
 *
 * Accepts weakly-typed or `unknown` values from the SDK and returns
 * well-typed shapes so the provider file itself stays free of unsafe casts.
 */

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Error narrowing
// ---------------------------------------------------------------------------

/** Narrow a caught `unknown` into an object with an optional HTTP status. */
export function narrowSdkError(err: unknown): { status?: number; message: string } {
  if (err instanceof AnthropicAPIError) {
    return { status: err.status as number | undefined, message: err.message };
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: String(err) };
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

export interface AnthropicCacheUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

/** Extract prompt-cache stats from an Anthropic Message.usage object. */
export function extractCacheUsage(usage: Anthropic.Usage): AnthropicCacheUsage {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    inputTokens: usage.input_tokens ?? 0,
    cachedTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Content-block-start narrowing
// ---------------------------------------------------------------------------

/** Check whether a content block from `content_block_start` is a tool_use block. */
export function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === 'tool_use';
}

// ---------------------------------------------------------------------------
// Content-block-delta narrowing
// ---------------------------------------------------------------------------

export type NarrowedDelta =
  | { kind: 'thinking'; thinking: string }
  | { kind: 'text'; text: string }
  | { kind: 'input_json'; partial_json: string }
  | { kind: 'other' };

/** Narrow an Anthropic streaming delta into one of the recognised shapes. */
export function narrowDelta(delta: Anthropic.RawContentBlockDelta): NarrowedDelta {
  switch (delta.type) {
    case 'thinking_delta':
      return { kind: 'thinking', thinking: delta.thinking };
    case 'text_delta':
      return { kind: 'text', text: delta.text };
    case 'input_json_delta':
      return { kind: 'input_json', partial_json: delta.partial_json };
    default:
      return { kind: 'other' };
  }
}
