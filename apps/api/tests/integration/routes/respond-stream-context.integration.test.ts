import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  makeChain,
  parsePersistedParts,
  parseSseEvents,
  restoreAllMocks,
} from './_respond-stream-helpers';

let TEST_USER!: UserFixture;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await restoreAllMocks();
});

describe('POST /respond/stream — context and continuation', () => {
  it('returns 503 when model catalog is not configured', async () => {
    await mock.module('../../../src/services/gemini', () => ({
      getGeminiModelCatalog: () =>
        Promise.resolve({
          configured: false,
          status: 'idle',
          allModels: [],
          textModels: [],
          imageModels: [],
          discoveredTextModels: [],
          discoveredImageModels: [],
        }),
      getDefaultTextModel: () => null,
      hasTextModel: () => false,
      clearGeminiModelCatalog: () => undefined as undefined,
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'some-chat', prompt: 'Hello' }),
      })
    );

    expect(response.status).toBe(503);
  });

  it('emits fallback_notice and context_info with mode=replay when provider yields continuation_degraded then turn_completed without cursor', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    const STATELESS_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      loopMessages: [],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield {
              type: 'continuation_degraded',
              from: 'stateful',
              to: 'replay',
              reason: 'cursor_expired',
              reasonCode: 'cursor_expired',
            };
            yield { type: 'assistant_text_delta', text: 'Hello' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hi', model: 'deepseek-chat' }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice).toMatchObject({
      type: 'fallback_notice',
      from: 'stateful',
      to: 'replay',
    });

    const continuationTransition = sseEvents.find((e) => e.type === 'continuation_transition');
    expect(continuationTransition).toBeDefined();
    expect(continuationTransition).toMatchObject({
      type: 'continuation_transition',
      provider: 'openai-compatible',
      fromMode: 'stateful',
      toMode: 'replay',
      reasonCode: 'cursor_expired',
      done: false,
    });

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo).toMatchObject({ type: 'context_info', mode: 'replay' });

    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const transitionPart = parts.find((p) => p.type === 'continuation_transition');
    expect(transitionPart).toBeDefined();
    expect(transitionPart).toMatchObject({
      type: 'continuation_transition',
      provider: 'openai-compatible',
      fromMode: 'stateful',
      toMode: 'replay',
      reasonCode: 'cursor_expired',
      recovered: true,
    });
  });

  it('emits fallback_notice with done:false and context_info with done:false in SSE output', async () => {
    const STATELESS_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      loopMessages: [],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield {
              type: 'continuation_degraded',
              from: 'responses',
              to: 'replay',
              reason: 'cursor_expired',
              reasonCode: 'cursor_expired',
            };
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: () => ({ execute: () => Promise.resolve() }),
        }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hi', model: 'deepseek-chat' }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice?.done).toBe(false);

    const continuationTransition = sseEvents.find((e) => e.type === 'continuation_transition');
    expect(continuationTransition).toBeDefined();
    expect(continuationTransition?.done).toBe(false);

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo?.done).toBe(false);
  });

  it('emits context_info with mode=stateful when provider returns a cursor in the envelope', async () => {
    const STATEFUL_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      cursor: 'resp_abc123',
      context: {
        providerReportedInputTokens: 2048,
        lastUpdatedAt: Date.now(),
      },
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: STATEFUL_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hi', model: 'gpt-4o' }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo).toMatchObject({
      type: 'context_info',
      mode: 'stateful',
      estimatedInputTokens: 2048,
    });
  });

  it('replays only the compacted boundary and newer turns after a chat compaction marker', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            yield {
              type: 'assistant_text_delta',
              text: JSON.stringify(req.history.map((turn) => turn.text)),
            };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    const messageRows = [
      {
        id: 'recent-ai',
        role: 'ai',
        text: 'Latest reply',
        parts: null,
        providerState: null,
        modelName: 'test-model',
      },
      {
        id: 'recent-user',
        role: 'user',
        text: 'Recent follow-up',
        parts: null,
        providerState: null,
        modelName: null,
      },
      {
        id: 'summary-ai',
        role: 'ai',
        text: 'Summary of earlier context',
        parts: JSON.stringify([
          { type: 'system_event', event: 'chat_compacted' },
          { type: 'text', text: 'Summary of earlier context' },
        ]),
        providerState: null,
        modelName: 'test-model',
      },
      {
        id: 'old-ai',
        role: 'ai',
        text: 'Old answer',
        parts: null,
        providerState: null,
        modelName: 'test-model',
      },
      {
        id: 'old-user',
        role: 'user',
        text: 'Old prompt',
        parts: null,
        providerState: null,
        modelName: null,
      },
    ];

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: (table: string) => {
          if (table === 'messages') {
            return {
              select: () => ({
                where: () => ({
                  where: () => ({
                    orderBy: () => ({
                      limit: () => ({
                        where: () => ({ execute: () => Promise.resolve(messageRows) }),
                        execute: () => Promise.resolve(messageRows),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }

          return makeChain({ userId: TEST_USER.id });
        },
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Continue', model: 'test-model' }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());
    const textEvent = sseEvents.find((event) => event.type === 'text');
    expect(textEvent?.text).toBe(
      JSON.stringify(['Summary of earlier context', 'Recent follow-up', 'Latest reply'])
    );
  });

  it('emits terminal error when provider errors on tool-result continuation', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    let iteration = 0;
    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            iteration += 1;
            if (iteration === 1) {
              yield { type: 'tool_call_started', callId: 'c1', name: 'noop' };
              yield { type: 'tool_call_completed', callId: 'c1', name: 'noop', arguments: '{}' };
              yield { type: 'turn_completed', providerState: null };
            } else {
              yield { type: 'turn_error', error: 'tool-result continuation failed' };
            }
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      getToolDefinitionsForAgent: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      executeTool: () => Promise.resolve({ ok: true }),
    }));

    const chatSetCalls: Array<Record<string, unknown>> = [];
    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => ({
          set: (values: Record<string, unknown>) => {
            chatSetCalls.push({ ...values });
            return makeChain(undefined);
          },
        }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'use tool', model: 'test-model' }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const errorEvent = sseEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBe('tool-result continuation failed');
    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();

    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const clearedDurable = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState === null
    );
    expect(clearedDurable).toBeDefined();
  });

  it('emits system_event(tool_loop_exhausted) and terminal error when loop ceiling is reached with pending tool calls', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield { type: 'tool_call_started', callId: 'c1', name: 'noop' };
            yield { type: 'tool_call_completed', callId: 'c1', name: 'noop', arguments: '{}' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      getToolDefinitionsForAgent: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      executeTool: () => Promise.resolve({ ok: true }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'loop forever',
          model: 'test-model',
          maxToolIterations: 2,
        }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const exhaustedEvent = sseEvents.find(
      (e) => e.type === 'system_event' && e.event === 'tool_loop_exhausted'
    );
    expect(exhaustedEvent).toBeDefined();
    expect(exhaustedEvent?.done).toBe(false);
    expect(typeof exhaustedEvent?.detail).toBe('string');

    const errorEvent = sseEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.done).toBe(true);

    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();

    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const exhaustedPart = parts.find(
      (p) => p.type === 'system_event' && p.event === 'tool_loop_exhausted'
    );
    expect(exhaustedPart).toBeDefined();
  });
});
