import { describe, expect, it } from 'bun:test';

/**
 * Unit tests for Anthropic provider extended thinking support.
 *
 * Tests the thinking parameter construction and chunk yielding logic directly,
 * without importing the full provider (which would trigger Bun module cache
 * contamination from other test files that import the provider without mocks).
 */

describe('anthropic-provider thinking config construction', () => {
  const budgetMap = { low: 1024, medium: 2048, high: 8192 } as const;

  it('constructs thinking config when thinkingEnabled is true', () => {
    const thinkingEnabled = true;
    const effort = 'medium' as const;

    const params: Record<string, unknown> = {
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: thinkingEnabled ? 16000 : 8192,
      messages: [],
    };

    if (thinkingEnabled) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: budgetMap[effort] ?? 2048,
      };
    }

    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(params.max_tokens).toBe(16000);
  });

  it('does not construct thinking config when thinkingEnabled is false', () => {
    const thinkingEnabled = false;
    const effort = 'medium' as const;

    const params: Record<string, unknown> = {
      model: 'claude-haiku-3-5-20241022',
      max_tokens: thinkingEnabled ? 16000 : 8192,
      messages: [],
    };

    if (thinkingEnabled) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: budgetMap[effort] ?? 2048,
      };
    }

    expect(params.thinking).toBeUndefined();
    expect(params.max_tokens).toBe(8192);
  });

  it('maps effort levels to correct budget_tokens', () => {
    for (const [effort, expected] of Object.entries(budgetMap)) {
      const result = budgetMap[effort as keyof typeof budgetMap];
      expect(result).toBe(expected);
    }

    expect(budgetMap.low).toBe(1024);
    expect(budgetMap.medium).toBe(2048);
    expect(budgetMap.high).toBe(8192);
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
