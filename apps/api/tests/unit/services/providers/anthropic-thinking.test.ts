import { describe, expect, it, mock, afterEach } from 'bun:test';

/**
 * Unit tests for Anthropic provider extended thinking support.
 * Mocks the Anthropic SDK to verify thinking config and chunk yielding.
 */

afterEach(() => {
  mock.restore();
});

/**
 * Sets up mocks for both the Anthropic SDK and the secret-service layer,
 * then dynamically imports the provider. The mock stream yields `streamEvents`.
 */
async function setupAnthropicMock(streamEvents: Array<Record<string, unknown>>) {
  let capturedParams: Record<string, unknown> | undefined;

  // Mock secret-service BEFORE importing the provider
  mock.module('../../../../src/services/providers/secret-service', () => ({
    createProviderSecretService: () => ({
      resolveApiKey: async () => 'mock-key',
      syncConfigFileConnectors: async () => {},
      listMeta: async () => [],
      validateApiKey: async () => {},
    }),
  }));

  mock.module('@anthropic-ai/sdk', () => ({
    default: class {
      models = { list: async function* () {} };
      messages = {
        stream: (params: Record<string, unknown>) => {
          capturedParams = params;
          return (async function* () {
            for (const event of streamEvents) {
              yield event;
            }
          })();
        },
      };
    },
  }));

  const mod = await import('../../../../src/services/providers/anthropic-provider');
  return { provider: mod.anthropicProvider, getCapturedParams: () => capturedParams };
}

describe('anthropic-provider thinking', () => {
  it('sends thinking config when thinkingEnabled is true', async () => {
    const { provider, getCapturedParams } = await setupAnthropicMock([]);

    for await (const _ of provider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hi',
      modelName: 'claude-sonnet-4-5-20250514',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    })) {
      // consume
    }

    expect(getCapturedParams()).toBeDefined();
    expect(getCapturedParams()!.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    });
    expect(getCapturedParams()!.max_tokens).toBe(16000);
  });

  it('does not send thinking config when thinkingEnabled is false', async () => {
    const { provider, getCapturedParams } = await setupAnthropicMock([]);

    for await (const _ of provider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hi',
      modelName: 'claude-haiku-3-5-20241022',
      generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    })) {
      // consume
    }

    expect(getCapturedParams()).toBeDefined();
    expect(getCapturedParams()!.thinking).toBeUndefined();
    expect(getCapturedParams()!.max_tokens).toBe(8192);
  });

  it('maps effort levels to correct budget_tokens', async () => {
    const budgets: Record<string, number> = {};

    for (const effort of ['low', 'medium', 'high'] as const) {
      mock.restore();

      let params: Record<string, unknown> | undefined;

      mock.module('../../../../src/services/providers/secret-service', () => ({
        createProviderSecretService: () => ({
          resolveApiKey: async () => 'mock-key',
          syncConfigFileConnectors: async () => {},
          listMeta: async () => [],
          validateApiKey: async () => {},
        }),
      }));

      mock.module('@anthropic-ai/sdk', () => ({
        default: class {
          models = { list: async function* () {} };
          messages = {
            stream: (p: Record<string, unknown>) => {
              params = p;
              return (async function* () {})();
            },
          };
        },
      }));

      const mod = await import('../../../../src/services/providers/anthropic-provider');

      for await (const _ of mod.anthropicProvider.generateTextStream!({
        userId: 'u1',
        history: [],
        prompt: 'Hi',
        modelName: 'claude-sonnet-4-5-20250514',
        generationConfig: { thinkingEnabled: true, reasoningEffort: effort },
      })) {
        // consume
      }

      const thinking = params?.thinking as { budget_tokens: number } | undefined;
      budgets[effort] = thinking?.budget_tokens ?? 0;
    }

    expect(budgets.low).toBe(1024);
    expect(budgets.medium).toBe(2048);
    expect(budgets.high).toBe(8192);
  });

  it('yields thinking chunks from thinking_delta events', async () => {
    const { provider } = await setupAnthropicMock([
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Here is my answer.' },
      },
    ]);

    const chunks = [];
    for await (const chunk of provider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hi',
      modelName: 'claude-sonnet-4-5-20250514',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Let me think...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'Here is my answer.', done: false });
    expect(chunks[2]).toEqual({ type: 'text', text: '', done: true });
  });
});
