import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { AddConnectorBodySchema } from '@mangostudio/shared/connectors';

import {
  normalizeDeepSeekReasoningEffort,
  buildDeepSeekSystemPrompt,
} from '../../../../src/services/providers/deepseek/normalizers';
import { validateDeepSeekApiKey } from '../../../../src/services/providers/deepseek/client';
import {
  fetchDeepSeekModels,
  getDeepSeekFallbackModels,
  toDeepSeekModelInfo,
} from '../../../../src/services/providers/deepseek/model-catalog';
import {
  buildDeepSeekMessages,
  buildDeepSeekRequestBody,
} from '../../../../src/services/providers/deepseek/message-mapper';
import { parseDeepSeekLoopState } from '../../../../src/services/providers/deepseek/agent-stream';
import {
  getContinuationStrategy,
  decideTurnPersistence,
} from '../../../../src/services/providers/core/continuation-runtime';
import type { ChatTurnContext } from '../../../../src/services/providers/types';

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

// ---------------------------------------------------------------------------
// Foundation
// ---------------------------------------------------------------------------

describe('DeepSeek provider foundation', () => {
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
