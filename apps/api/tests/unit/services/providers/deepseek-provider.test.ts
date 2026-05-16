import { describe, expect, it } from 'bun:test';
import { AddConnectorBodySchema } from '@mangostudio/shared/connectors';
import { Value } from '@sinclair/typebox/value';
import {
  decideTurnPersistence,
  getContinuationStrategy,
} from '../../../../src/services/providers/core/continuation-runtime';
import {
  parseDeepSeekLoopState,
  streamDeepSeekAgentTurn,
} from '../../../../src/services/providers/deepseek/agent-stream';
import {
  createDeepSeekAgentClient,
  createDeepSeekClient,
  validateDeepSeekApiKey,
} from '../../../../src/services/providers/deepseek/client';
import {
  buildDeepSeekMessages,
  buildDeepSeekRequestBody,
} from '../../../../src/services/providers/deepseek/message-mapper';
import {
  fetchDeepSeekModels,
  getDeepSeekFallbackModels,
  toDeepSeekModelInfo,
} from '../../../../src/services/providers/deepseek/model-catalog';
import {
  buildDeepSeekSystemPrompt,
  normalizeDeepSeekReasoningEffort,
} from '../../../../src/services/providers/deepseek/normalizers';
import type { AgentTurnRequest, ChatTurnContext } from '../../../../src/services/providers/types';
import {
  chainChunks,
  stopChunk,
  textDeltaChunk,
} from '../../../support/providers/fake-chat-completions';
import {
  createFakeDeepSeekClient,
  deepSeekUsageChunk,
  reasoningDeltaChunk,
  toolCallSequence,
} from '../../../support/providers/fake-deepseek-stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createModelListFetch(
  status = 200
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
        }),
        { status, headers: { 'Content-Type': 'application/json' } }
      )
    );
}

function buildHistory(
  turns: Array<{ id: string; role: 'user' | 'ai'; text: string }>
): ChatTurnContext[] {
  return turns.map((t) => ({ id: t.id, role: t.role, text: t.text }));
}

interface CompletedEvent {
  type: 'turn_completed';
  providerState?: string;
}

function isCompletedEvent(e: unknown): e is CompletedEvent {
  return (
    typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'turn_completed'
  );
}

function parseProviderState(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

function findAssistantMsg(state: Record<string, unknown>): Record<string, unknown> | undefined {
  const loopMessages = state.loopMessages as Array<Record<string, unknown>> | undefined;
  return loopMessages?.find((m) => m.role === 'assistant');
}

// ---------------------------------------------------------------------------
// Foundation
// ---------------------------------------------------------------------------

describe('DeepSeek provider foundation', () => {
  it('reuses the same SDK client for the same connector config', () => {
    const clientA = createDeepSeekClient({
      apiKey: 'sk-test-deepseek-cache',
      baseUrl: 'https://api.deepseek.com',
    });
    const clientB = createDeepSeekClient({
      apiKey: 'sk-test-deepseek-cache',
      baseUrl: 'https://api.deepseek.com/',
    });

    expect(clientA).toBe(clientB);
  });

  it('reuses the same agent client for the same connector config', () => {
    const clientA = createDeepSeekAgentClient({
      apiKey: 'sk-test-deepseek-agent-cache',
      baseUrl: 'https://api.deepseek.com',
    });
    const clientB = createDeepSeekAgentClient({
      apiKey: 'sk-test-deepseek-agent-cache',
      baseUrl: 'https://api.deepseek.com/',
    });

    expect(clientA).toBe(clientB);
  });

  it('creates different clients when connector config changes', () => {
    const flashClient = createDeepSeekAgentClient({
      apiKey: 'sk-test-deepseek-agent-cache-a',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const alternateClient = createDeepSeekAgentClient({
      apiKey: 'sk-test-deepseek-agent-cache-b',
      baseUrl: 'https://api.deepseek.com/v1',
    });

    expect(flashClient).not.toBe(alternateClient);
  });

  it('accepts deepseek in connector contracts', () => {
    expect(
      Value.Check(AddConnectorBodySchema, {
        name: 'personal',
        apiKey: 'sk-test-key',
        source: 'bun-secrets',
        provider: 'deepseek',
      })
    ).toBe(true);
  });

  it('validates API keys through the DeepSeek models endpoint', async () => {
    await validateDeepSeekApiKey({ apiKey: 'sk-test-key', fetchImpl: createModelListFetch() });
  });

  it('maps discovered models to DeepSeek capabilities', async () => {
    const models = await fetchDeepSeekModels({
      apiKey: 'sk-test-key',
      fetchImpl: createModelListFetch(),
    });

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      modelId: 'deepseek-v4-flash',
      provider: 'deepseek',
      inputTokenLimit: 1_048_576,
      capabilities: {
        text: true,
        streaming: true,
        reasoning: true,
        tools: true,
        statefulContinuation: false,
        promptCaching: true,
        reasoningWithTools: true,
        structuredOutput: true,
      },
    });
  });

  it('marks compatibility aliases with safe capabilities', () => {
    expect(toDeepSeekModelInfo('deepseek-reasoner')).toMatchObject({
      capabilities: { reasoning: true, tools: false, reasoningWithTools: false },
    });
    expect(getDeepSeekFallbackModels().map((model) => model.modelId)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
  });
});

// ---------------------------------------------------------------------------
// normalizeDeepSeekReasoningEffort
// ---------------------------------------------------------------------------

describe('normalizeDeepSeekReasoningEffort', () => {
  it('maps low to high', () => {
    expect(normalizeDeepSeekReasoningEffort('low')).toBe('high');
  });

  it('maps medium to high', () => {
    expect(normalizeDeepSeekReasoningEffort('medium')).toBe('high');
  });

  it('keeps high as high', () => {
    expect(normalizeDeepSeekReasoningEffort('high')).toBe('high');
  });

  it('maps xhigh to max', () => {
    expect(normalizeDeepSeekReasoningEffort('xhigh')).toBe('max');
  });

  it('keeps max as max', () => {
    expect(normalizeDeepSeekReasoningEffort('max')).toBe('max');
  });
});

// ---------------------------------------------------------------------------
// buildDeepSeekSystemPrompt
// ---------------------------------------------------------------------------

describe('buildDeepSeekSystemPrompt', () => {
  it('adds reasoning language hint when thinking is enabled', () => {
    const result = buildDeepSeekSystemPrompt({
      userId: 'test-user',
      history: [],
      prompt: 'Explique com calma em português.',
      systemPrompt: 'You are concise.',
      modelName: 'deepseek-v4-flash',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    });

    expect(result).toContain('You are concise.');
    expect(result).toContain('same natural language as the current user message');
  });

  it('does not add the reasoning language hint when thinking is disabled', () => {
    expect(
      buildDeepSeekSystemPrompt({
        userId: 'test-user',
        history: [],
        prompt: 'Hello',
        systemPrompt: 'You are concise.',
        modelName: 'deepseek-v4-flash',
        generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
      })
    ).toBe('You are concise.');
  });
});

// ---------------------------------------------------------------------------
// buildDeepSeekMessages
// ---------------------------------------------------------------------------

describe('buildDeepSeekMessages', () => {
  const history = buildHistory([
    { id: '1', role: 'user', text: 'What is the weather?' },
    { id: '2', role: 'ai', text: 'The weather is sunny.' },
  ]);

  it('includes system prompt when provided', () => {
    const messages = buildDeepSeekMessages({
      systemPrompt: 'You are a helpful assistant.',
      history: [],
    });

    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
  });

  it('omits system prompt when not provided', () => {
    const messages = buildDeepSeekMessages({ history: [] });

    expect(messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('builds replay from history', () => {
    const messages = buildDeepSeekMessages({ history });

    expect(messages).toContainEqual({ role: 'user', content: 'What is the weather?' });
    expect(messages).toContainEqual({ role: 'assistant', content: 'The weather is sunny.' });
  });

  it('includes loop messages after history', () => {
    const loopMessages = [{ role: 'assistant', content: 'Intermediate thought.' }];
    const messages = buildDeepSeekMessages({ history, loopMessages });

    const idx1 = messages.findIndex((m) => m.content === 'What is the weather?');
    const idx2 = messages.findIndex((m) => m.content === 'Intermediate thought.');
    expect(idx2).toBeGreaterThan(idx1);
  });

  it('adds tool results as tool role messages', () => {
    const messages = buildDeepSeekMessages({
      history,
      toolResults: [{ callId: 'call_1', name: 'get_weather', result: '{"temp":22}' }],
    });

    expect(messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"temp":22}',
    });
  });

  it('adds user prompt when no tool results', () => {
    const messages = buildDeepSeekMessages({
      history: [],
      prompt: 'Hello!',
    });

    expect(messages).toContainEqual({ role: 'user', content: 'Hello!' });
  });

  it('prefers tool results over user prompt', () => {
    const messages = buildDeepSeekMessages({
      history: [],
      prompt: 'This should not appear',
      toolResults: [{ callId: 'c1', name: 'tool', result: 'result' }],
    });

    expect(messages.some((m) => m.content === 'This should not appear')).toBe(false);
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDeepSeekRequestBody
// ---------------------------------------------------------------------------

describe('buildDeepSeekRequestBody', () => {
  it('includes stream and stream_options', () => {
    const body = buildDeepSeekRequestBody({
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingEnabled: false,
    });

    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('includes thinking when enabled', () => {
    const body = buildDeepSeekRequestBody({
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingEnabled: true,
      reasoningEffort: 'high',
    });

    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('normalizes reasoning effort according to DeepSeek mapping', () => {
    const body = buildDeepSeekRequestBody({
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingEnabled: true,
      reasoningEffort: 'medium',
    });

    expect(body.reasoning_effort).toBe('high');
  });

  it('omits thinking config when thinking is disabled', () => {
    const body = buildDeepSeekRequestBody({
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingEnabled: false,
    });

    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('includes tools when provided', () => {
    const body = buildDeepSeekRequestBody({
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingEnabled: false,
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: {} },
        },
      ],
    });

    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools when empty', () => {
    const body = buildDeepSeekRequestBody({
      modelName: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingEnabled: false,
      tools: [],
    });

    expect(body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseDeepSeekLoopState
// ---------------------------------------------------------------------------

describe('parseDeepSeekLoopState', () => {
  it('returns null for null input', () => {
    expect(parseDeepSeekLoopState(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseDeepSeekLoopState(undefined)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseDeepSeekLoopState('not-json')).toBeNull();
  });

  it('returns null for wrong provider', () => {
    const state = JSON.stringify({ provider: 'openai-compatible', loopMessages: [] });
    expect(parseDeepSeekLoopState(state)).toBeNull();
  });

  it('parses valid loop state', () => {
    const state = JSON.stringify({
      provider: 'deepseek',
      loopMessages: [{ role: 'assistant', content: 'Hello' }],
    });
    const parsed = parseDeepSeekLoopState(state);
    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe('deepseek');
    expect(parsed?.loopMessages).toHaveLength(1);
  });

  it('returns null when loopMessages is not an array', () => {
    const state = JSON.stringify({ provider: 'deepseek', loopMessages: 'not-array' });
    expect(parseDeepSeekLoopState(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DeepSeek continuation strategy
// ---------------------------------------------------------------------------

describe('DeepSeek continuation strategy', () => {
  it('uses turn-local strategy', () => {
    const strategy = getContinuationStrategy('deepseek');
    expect(strategy.strategy).toBe('turn-local');
    expect(strategy.supportsDurableCursor).toBe(false);
    expect(strategy.durableMode).toBeNull();
  });

  it('does not persist DeepSeek loop state as durable', () => {
    const providerState = JSON.stringify({
      schemaVersion: 1,
      provider: 'deepseek',
      mode: 'stateless-loop',
      modelName: 'deepseek-v4-flash',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
      loopMessages: [{ role: 'assistant', content: 'hi' }],
    });

    const result = decideTurnPersistence(providerState, 'deepseek');
    expect(result.envelope?.mode).toBe('stateless-loop');
    expect(result.durableProviderState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// streamDeepSeekAgentTurn — agent stream integration
// ---------------------------------------------------------------------------

describe('streamDeepSeekAgentTurn', () => {
  const baseReq: AgentTurnRequest = {
    userId: 'test-user',
    modelName: 'deepseek-v4-flash',
    history: [],
    generationConfig: { thinkingEnabled: true, reasoningEffort: 'high' },
  };

  function collect(req: AgentTurnRequest, stream: AsyncIterable<Record<string, unknown>>) {
    const client = createFakeDeepSeekClient(stream);
    return streamDeepSeekAgentTurn(client as never, req);
  }

  it('yields assistant_text_delta for plain text', async () => {
    const stream = chainChunks(textDeltaChunk('Hello'), stopChunk());
    const events: unknown[] = [];
    for await (const ev of collect(baseReq, stream)) events.push(ev);

    expect(events).toContainEqual({ type: 'assistant_text_delta', text: 'Hello' });
    const completed = events.find(
      (e): e is { type: 'turn_completed' } => (e as { type: string }).type === 'turn_completed'
    );
    expect(completed).toBeDefined();
  });

  it('yields reasoning_delta for reasoning content', async () => {
    const stream = chainChunks(reasoningDeltaChunk('Step 1: think', 'Final answer'), stopChunk());
    const events: unknown[] = [];
    for await (const ev of collect(baseReq, stream)) events.push(ev);

    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Step 1: think' });
    expect(events).toContainEqual({ type: 'assistant_text_delta', text: 'Final answer' });
  });

  it('yields tool_call_started and tool_call_completed for tool calls', async () => {
    const stream = chainChunks(
      toolCallSequence('Need weather data', 'call_1', 'get_weather', '{"city":"Paris"}')
    );
    const events: unknown[] = [];
    for await (const ev of collect(baseReq, stream)) events.push(ev);

    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Need weather data' });
    expect(events).toContainEqual({
      type: 'tool_call_started',
      callId: 'call_1',
      name: 'get_weather',
    });
    expect(events).toContainEqual({
      type: 'tool_call_completed',
      callId: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    });
  });

  it('preserves reasoning_content in loop state when tool calls are present', async () => {
    const stream = chainChunks(
      toolCallSequence('Thinking about tools', 'call_x', 'search', '{"q":"test"}'),
      deepSeekUsageChunk(50, 10)
    );
    const events: unknown[] = [];
    for await (const ev of collect(baseReq, stream)) events.push(ev);

    const completed = events.find(isCompletedEvent);
    expect(completed).toBeDefined();
    const completedEvent = completed as CompletedEvent;
    expect(completedEvent.providerState).toBeDefined();

    const state = parseProviderState(completedEvent.providerState as string);
    expect(state.provider).toBe('deepseek');
    expect(state.mode).toBe('stateless-loop');

    const assistantMsg = findAssistantMsg(state);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.reasoning_content).toBe('Thinking about tools');
    expect(assistantMsg?.tool_calls).toHaveLength(1);
  });

  it('omits reasoning_content from final assistant message when no tool calls', async () => {
    const stream = chainChunks(
      reasoningDeltaChunk('Just thinking', 'Answer here'),
      stopChunk(),
      deepSeekUsageChunk(30, 15)
    );
    const events: unknown[] = [];
    for await (const ev of collect(baseReq, stream)) events.push(ev);

    const completed = events.find(isCompletedEvent);
    expect(completed).toBeDefined();

    const state = parseProviderState((completed as CompletedEvent).providerState as string);
    const assistantMsg = findAssistantMsg(state);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.reasoning_content).toBeUndefined();
  });

  it('includes cache metrics in provider state when DeepSeek returns them', async () => {
    const stream = chainChunks(
      textDeltaChunk('Cached response'),
      stopChunk(),
      deepSeekUsageChunk(100, 20, 80, 20)
    );
    const events: unknown[] = [];
    for await (const ev of collect(baseReq, stream)) events.push(ev);

    const completed = events.find(isCompletedEvent);
    expect(completed).toBeDefined();

    const state = parseProviderState((completed as CompletedEvent).providerState as string);
    expect(state.promptCacheHitTokens).toBe(80);
    expect(state.promptCacheMissTokens).toBe(20);
  });

  it('emits turn_error on API failure', async () => {
    const brokenClient = createFakeDeepSeekClient({
      [Symbol.asyncIterator]() {
        return {
          next() {
            throw new Error('API connection failed');
          },
        };
      },
    });

    const events: unknown[] = [];
    try {
      for await (const ev of streamDeepSeekAgentTurn(brokenClient as never, baseReq)) {
        events.push(ev);
      }
    } catch {
      // some iterations may throw instead of yielding turn_error
    }

    const error = events.find(
      (e): e is { type: 'turn_error'; error: string } =>
        (e as { type: string }).type === 'turn_error'
    );
    if (error) {
      expect(error.error).toContain('API connection failed');
    }
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    const chunks: Record<string, unknown>[] = [
      { choices: [{ delta: { content: 'First' }, finish_reason: null }] },
    ];
    const abortClient = createFakeDeepSeekClient(new AbortableAsyncStream(chunks, controller));

    const req: AgentTurnRequest = { ...baseReq, signal: controller.signal };
    const events: unknown[] = [];
    for await (const ev of streamDeepSeekAgentTurn(abortClient as never, req)) {
      events.push(ev);
    }

    expect(
      events.filter((e) => (e as { type: string }).type === 'assistant_text_delta')
    ).toHaveLength(1);
  });
});

class AbortableAsyncStream {
  constructor(
    private chunks: Record<string, unknown>[],
    private controller: AbortController
  ) {}
  async *[Symbol.asyncIterator]() {
    for (const chunk of this.chunks) {
      if (this.controller.signal.aborted) break;
      yield await Promise.resolve(chunk);
    }
  }
}
