import { describe, expect, it } from 'bun:test';
import { buildAnthropicThinkingConfig } from '../../../../src/services/providers/anthropic/thinking-config';

/**
 * Unit tests for Anthropic provider extended thinking support.
 *
 * Tests the real thinking-config builder plus the chunk-yielding logic. The
 * chunk simulation avoids importing the full provider (which would trigger Bun
 * module-cache contamination from other test files that import it without mocks).
 */

describe('buildAnthropicThinkingConfig', () => {
  it('constructs an enabled config when thinking is on', () => {
    expect(buildAnthropicThinkingConfig(true, 'medium')).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    });
  });

  it('returns undefined when thinking is off', () => {
    expect(buildAnthropicThinkingConfig(false, 'medium')).toBeUndefined();
  });

  it('maps each effort level to its token budget', () => {
    expect(buildAnthropicThinkingConfig(true, 'low')?.budget_tokens).toBe(1024);
    expect(buildAnthropicThinkingConfig(true, 'medium')?.budget_tokens).toBe(2048);
    expect(buildAnthropicThinkingConfig(true, 'high')?.budget_tokens).toBe(8192);
    expect(buildAnthropicThinkingConfig(true, 'xhigh')?.budget_tokens).toBe(8192);
    expect(buildAnthropicThinkingConfig(true, 'max')?.budget_tokens).toBe(8192);
  });
});

describe('anthropic-provider thinking chunk yielding', () => {
  /**
   * Simulates the provider's stream event processing logic without
   * needing the actual Anthropic SDK or secretService.
   */
  async function* processAnthropicStreamEvents(
    events: Array<Record<string, unknown>>
  ): AsyncIterable<{ type: string; text: string; done: boolean }> {
    await Promise.resolve();
    for (const event of events) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'thinking', text: delta.thinking, done: false };
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', text: delta.text, done: false };
        }
      }
    }
    yield { type: 'text', text: '', done: true };
  }

  it('yields thinking chunks from thinking_delta events', async () => {
    const chunks = [];
    for await (const chunk of processAnthropicStreamEvents([
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Here is my answer.' },
      },
    ])) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Let me think...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'Here is my answer.', done: false });
    expect(chunks[2]).toEqual({ type: 'text', text: '', done: true });
  });

  it('ignores non-thinking non-text deltas', async () => {
    const chunks = [];
    for await (const chunk of processAnthropicStreamEvents([
      {
        type: 'content_block_delta',
        delta: { type: 'signature_delta', signature: 'abc' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Only text.' },
      },
    ])) {
      chunks.push(chunk);
    }

    // Should skip the signature delta
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ type: 'text', text: 'Only text.', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: '', done: true });
  });

  it('handles mixed thinking and text deltas', async () => {
    const chunks = [];
    for await (const chunk of processAnthropicStreamEvents([
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Step 1...' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: ' Step 2...' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Final answer.' },
      },
    ])) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(4); // 2 thinking + 1 text + 1 done
    expect(chunks[0].type).toBe('thinking');
    expect(chunks[1].type).toBe('thinking');
    expect(chunks[2].type).toBe('text');
    expect(chunks[3].done).toBe(true);
  });
});
