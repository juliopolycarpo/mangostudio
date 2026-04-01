import { describe, expect, it, mock, afterEach } from 'bun:test';
import { isReasoningModel } from '@mangostudio/shared/utils/model-detection';

/**
 * Unit tests for OpenAI provider reasoning support via the Responses API.
 * Tests model detection, API bifurcation, and reasoning event parsing.
 */

afterEach(() => {
  mock.restore();
});

describe('isReasoningModel detection', () => {
  it('detects o-series models', () => {
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  it('detects gpt-5 family', () => {
    expect(isReasoningModel('gpt-5')).toBe(true);
    expect(isReasoningModel('gpt-5.1-mini')).toBe(true);
    expect(isReasoningModel('gpt-5.4-nano')).toBe(true);
  });

  it('does not match non-reasoning models', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('gpt-4o-mini')).toBe(false);
    expect(isReasoningModel('dall-e-3')).toBe(false);
  });

  it('detects Anthropic reasoning models', () => {
    expect(isReasoningModel('claude-3-5-sonnet-20241022')).toBe(true);
    expect(isReasoningModel('claude-sonnet-4-5-20250514')).toBe(true);
    expect(isReasoningModel('claude-opus-4-20250514')).toBe(true);
  });

  it('detects Gemini 2.5 reasoning models', () => {
    expect(isReasoningModel('gemini-2.5-pro')).toBe(true);
    expect(isReasoningModel('gemini-2.5-flash')).toBe(true);
  });

  it('does not match Gemini 2.0', () => {
    expect(isReasoningModel('gemini-2.0-flash')).toBe(false);
  });
});

describe('openai-provider Responses API streaming', () => {
  /**
   * Helper: creates a mock OpenAI SDK client class that captures calls
   * and returns a mock stream from responses.create().
   */
  function createMockOpenAI(streamEvents: Array<Record<string, unknown>>) {
    let capturedResponsesParams: Record<string, unknown> | undefined;
    let capturedCompletionsParams: Record<string, unknown> | undefined;

    const MockOpenAI = class {
      responses = {
        create: async (params: Record<string, unknown>) => {
          capturedResponsesParams = params;
          return (async function* () {
            for (const event of streamEvents) {
              yield event;
            }
          })();
        },
      };
      chat = {
        completions: {
          create: async (params: Record<string, unknown>) => {
            capturedCompletionsParams = params;
            return (async function* () {
              yield { choices: [{ delta: { content: 'Hello' } }] };
            })();
          },
        },
      };
      models = {
        list: async () => ({ data: [] }),
      };
    };

    return {
      MockOpenAI,
      getCapturedResponsesParams: () => capturedResponsesParams,
      getCapturedCompletionsParams: () => capturedCompletionsParams,
    };
  }

  function setupMocks(streamEvents: Array<Record<string, unknown>>) {
    const { MockOpenAI, getCapturedResponsesParams, getCapturedCompletionsParams } =
      createMockOpenAI(streamEvents);

    mock.module('openai', () => ({ default: MockOpenAI }));

    mock.module('../../../../src/services/providers/secret-service', () => ({
      createProviderSecretService: () => ({
        resolveApiKey: async () => 'mock-key',
        syncConfigFileConnectors: async () => {},
        listMeta: async () => [
          {
            id: 'mock-row',
            configured: 1,
            enabledModels: '[]',
            organizationId: null,
            projectId: null,
          },
        ],
        resolveSecretValue: async () => 'mock-key',
        validateApiKey: async () => {},
      }),
    }));

    return { getCapturedResponsesParams, getCapturedCompletionsParams };
  }

  it('uses Responses API for reasoning models with thinking enabled', async () => {
    const { getCapturedResponsesParams, getCapturedCompletionsParams } = setupMocks([
      { type: 'response.output_text.delta', delta: 'Hi' },
    ]);

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');

    for await (const _ of openAIProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hello',
      modelName: 'o4-mini',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'high' },
    })) {
      // consume
    }

    expect(getCapturedResponsesParams()).toBeDefined();
    expect(getCapturedResponsesParams()!.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(getCapturedCompletionsParams()).toBeUndefined();
  });

  it('uses Chat Completions for non-reasoning models', async () => {
    const { getCapturedResponsesParams, getCapturedCompletionsParams } = setupMocks([]);

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');

    for await (const _ of openAIProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hello',
      modelName: 'gpt-4o',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'high' },
    })) {
      // consume
    }

    expect(getCapturedCompletionsParams()).toBeDefined();
    expect(getCapturedResponsesParams()).toBeUndefined();
  });

  it('uses Chat Completions when thinking is disabled for reasoning models', async () => {
    const { getCapturedResponsesParams, getCapturedCompletionsParams } = setupMocks([]);

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');

    for await (const _ of openAIProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hello',
      modelName: 'o4-mini',
      generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    })) {
      // consume
    }

    expect(getCapturedCompletionsParams()).toBeDefined();
    expect(getCapturedResponsesParams()).toBeUndefined();
  });

  it('yields thinking from reasoning_summary_text.delta', async () => {
    setupMocks([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Thinking about this...',
      },
      {
        type: 'response.output_text.delta',
        delta: 'The answer is 42.',
      },
    ]);

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');
    const chunks = [];

    for await (const chunk of openAIProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hello',
      modelName: 'o4-mini',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Thinking about this...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'The answer is 42.', done: false });
    expect(chunks[chunks.length - 1]).toEqual({ type: 'text', text: '', done: true });
  });

  it('falls back to reasoning_text.delta when no summary events', async () => {
    setupMocks([
      {
        type: 'response.reasoning_text.delta',
        item_id: 'item1',
        content_index: 0,
        delta: 'Raw reasoning...',
      },
      {
        type: 'response.output_text.delta',
        delta: 'Result.',
      },
    ]);

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');
    const chunks = [];

    for await (const chunk of openAIProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hello',
      modelName: 'gpt-5',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'low' },
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Raw reasoning...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'Result.', done: false });
  });

  it('deduplicates summary events already seen via delta', async () => {
    setupMocks([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Streamed thinking.',
      },
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'item1',
        summary_index: 0,
        text: 'Streamed thinking.',
      },
      {
        type: 'response.output_text.delta',
        delta: 'Answer.',
      },
    ]);

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');
    const chunks = [];

    for await (const chunk of openAIProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hello',
      modelName: 'o4-mini',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    })) {
      chunks.push(chunk);
    }

    // Should only see one thinking chunk (from delta), not two
    const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
    expect(thinkingChunks.length).toBe(1);
    expect(thinkingChunks[0]!.text).toBe('Streamed thinking.');
  });

  it('falls back to response.completed reasoning extraction', async () => {
    setupMocks([
      {
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: 'Fallback reasoning from completed.' },
              ],
            },
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Final answer.' }],
            },
          ],
        },
      },
    ]);

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');
    const chunks = [];

    for await (const chunk of openAIProvider.generateTextStream!({
      userId: 'u1',
      history: [],
      prompt: 'Hello',
      modelName: 'o4-mini',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    })) {
      chunks.push(chunk);
    }

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
    expect(thinkingChunks.length).toBe(1);
    expect(thinkingChunks[0]!.text).toBe('Fallback reasoning from completed.');
  });
});
