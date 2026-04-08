import { describe, expect, it } from 'bun:test';
import { buildCachedAnthropicRequest } from '../../../../src/services/providers/anthropic-cache-builder';
import type { ToolDefinition } from '../../../../src/services/providers/types';

type CacheableBlock = {
  text?: string;
  cache_control?: { type: string };
  name?: string;
  input_schema?: unknown;
};

const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'get_current_datetime',
    description: 'Returns the current date and time.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search',
    description: 'Searches the web.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

describe('buildCachedAnthropicRequest', () => {
  it('sets cache_control on system prompt block', () => {
    const result = buildCachedAnthropicRequest({
      systemPrompt: 'You are a helpful assistant.',
      toolDefinitions: [],
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.system).toHaveLength(1);
    expect((result.system as CacheableBlock[])[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((result.system as CacheableBlock[])[0].text).toBe('You are a helpful assistant.');
  });

  it('sets cache_control only on the last tool definition', () => {
    const result = buildCachedAnthropicRequest({
      systemPrompt: 'Assistant',
      toolDefinitions: TOOL_DEFS,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.tools).toHaveLength(2);
    expect((result.tools as CacheableBlock[])[0].cache_control).toBeUndefined();
    expect((result.tools as CacheableBlock[])[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits system when prompt is empty', () => {
    const result = buildCachedAnthropicRequest({
      systemPrompt: '',
      toolDefinitions: TOOL_DEFS,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.system).toBeUndefined();
  });

  it('omits tools when definitions are empty', () => {
    const result = buildCachedAnthropicRequest({
      systemPrompt: 'Hello',
      toolDefinitions: [],
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.tools).toBeUndefined();
  });

  it('passes messages through unchanged', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
      { role: 'user' as const, content: 'How are you?' },
    ];

    const result = buildCachedAnthropicRequest({
      systemPrompt: 'You are helpful.',
      toolDefinitions: [],
      messages,
    });

    expect(result.messages).toEqual(messages);
  });

  it('includes thinking config when provided', () => {
    const result = buildCachedAnthropicRequest({
      systemPrompt: 'Hello',
      toolDefinitions: [],
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingConfig: { type: 'enabled', budget_tokens: 4096 },
    });

    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(result.max_tokens).toBe(16000);
  });

  it('uses 8192 max_tokens without thinking', () => {
    const result = buildCachedAnthropicRequest({
      systemPrompt: 'Hello',
      toolDefinitions: [],
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.max_tokens).toBe(8192);
  });

  it('preserves tool input_schema from parameters', () => {
    const result = buildCachedAnthropicRequest({
      systemPrompt: 'Hello',
      toolDefinitions: TOOL_DEFS,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const searchTool = (result.tools as CacheableBlock[]).find((t) => t.name === 'search');
    expect(searchTool?.input_schema).toEqual(TOOL_DEFS[1].parameters);
  });
});
