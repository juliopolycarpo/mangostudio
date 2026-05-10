import { describe, expect, it } from 'bun:test';
import { createAnthropicClient } from '../../../../src/services/providers/anthropic/client';

describe('createAnthropicClient', () => {
  it('reuses the same client for the same API key', () => {
    const clientA = createAnthropicClient('sk-ant-cache');
    const clientB = createAnthropicClient('sk-ant-cache');

    expect(clientA).toBe(clientB);
  });

  it('creates a different client when the API key changes', () => {
    const clientA = createAnthropicClient('sk-ant-cache-a');
    const clientB = createAnthropicClient('sk-ant-cache-b');

    expect(clientA).not.toBe(clientB);
  });
});
