import { describe, expect, it, mock, afterEach } from 'bun:test';

/**
 * Unit tests for Anthropic provider extended thinking support.
 * Mocks the Anthropic SDK to verify thinking config and chunk yielding.
 */

afterEach(() => {
  mock.restore();
});

describe('anthropic-provider thinking', () => {
  it('sends thinking config when thinkingEnabled is true', async () => {
    let capturedParams: Record<string, unknown> | undefined;

    mock.module('@anthropic-ai/sdk', () => ({
      default: class {
        models = { list: async function* () {} };
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedParams = params;
            return (async function* () {
              // empty stream
            })();
          },
        };
      },
    }));

    mock.module('../../../../src/services/providers/secret-service', () => ({
      createProviderSecretService: () => ({
        resolveApiKey: async () => 'mock-key',
        syncConfigFileConnectors: async () => {},
        listMeta: async () => [],
        validateApiKey: async () => {},
      }),
    }));

    const mod = await import('../../../../src/services/providers/anthropic-provider');
    const provider = mod.anthropicProvider;

    for await (const _ of provider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hi',
      modelName: 'claude-sonnet-4-5-20250514',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    })) {
      // consume
    }

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(capturedParams!.max_tokens).toBe(16000);
  });

  it('does not send thinking config when thinkingEnabled is false', async () => {
    let capturedParams: Record<string, unknown> | undefined;

    mock.module('@anthropic-ai/sdk', () => ({
      default: class {
        models = { list: async function* () {} };
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedParams = params;
            return (async function* () {})();
          },
        };
      },
    }));

    mock.module('../../../../src/services/providers/secret-service', () => ({
      createProviderSecretService: () => ({
        resolveApiKey: async () => 'mock-key',
        syncConfigFileConnectors: async () => {},
        listMeta: async () => [],
        validateApiKey: async () => {},
      }),
    }));

    const mod = await import('../../../../src/services/providers/anthropic-provider');

    for await (const _ of mod.anthropicProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hi',
      modelName: 'claude-haiku-3-5-20241022',
      generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    })) {
      // consume
    }

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.thinking).toBeUndefined();
    expect(capturedParams!.max_tokens).toBe(8192);
  });

  it('maps effort levels to correct budget_tokens', async () => {
    const budgets: Record<string, number> = {};

    for (const effort of ['low', 'medium', 'high'] as const) {
      mock.module('@anthropic-ai/sdk', () => ({
        default: class {
          models = { list: async function* () {} };
          messages = {
            stream: (params: Record<string, unknown>) => {
              const thinking = params.thinking as { budget_tokens: number } | undefined;
              budgets[effort] = thinking?.budget_tokens ?? 0;
              return (async function* () {})();
            },
          };
        },
      }));

      mock.module('../../../../src/services/providers/secret-service', () => ({
        createProviderSecretService: () => ({
          resolveApiKey: async () => 'mock-key',
          syncConfigFileConnectors: async () => {},
          listMeta: async () => [],
          validateApiKey: async () => {},
        }),
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

      mock.restore();
    }

    expect(budgets.low).toBe(1024);
    expect(budgets.medium).toBe(2048);
    expect(budgets.high).toBe(8192);
  });

  it('yields thinking chunks from thinking_delta events', async () => {
    mock.module('@anthropic-ai/sdk', () => ({
      default: class {
        models = { list: async function* () {} };
        messages = {
          stream: () =>
            (async function* () {
              yield {
                type: 'content_block_delta',
                delta: { type: 'thinking_delta', thinking: 'Let me think...' },
              };
              yield {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'Here is my answer.' },
              };
            })(),
        };
      },
    }));

    mock.module('../../../../src/services/providers/secret-service', () => ({
      createProviderSecretService: () => ({
        resolveApiKey: async () => 'mock-key',
        syncConfigFileConnectors: async () => {},
        listMeta: async () => [],
        validateApiKey: async () => {},
      }),
    }));

    const mod = await import('../../../../src/services/providers/anthropic-provider');
    const chunks = [];

    for await (const chunk of mod.anthropicProvider.generateTextStream!({
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
