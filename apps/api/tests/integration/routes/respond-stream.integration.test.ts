import { describe, expect, it, mock, afterEach } from 'bun:test';
import { respondStreamRoutes } from '../../../src/routes/respond-stream';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import type { AgentTurnRequest } from '../../../src/services/providers/types';

const TEST_USER = {
  id: 'test-user-stream',
  name: 'Stream User',
  email: 'stream@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  mock.restore();
});

describe('POST /respond/stream', () => {
  it('returns 404 when chat is not found', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'nonexistent-chat', prompt: 'Hello' }),
      })
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body).toHaveProperty('error');
  });

  it('accepts thinkingVisibility in request body without error', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'nonexistent-chat',
          prompt: 'Hello',
          thinkingVisibility: 'summary',
        }),
      })
    );

    // Should reach the chat ownership check (404), not a schema validation error (422)
    expect(response.status).toBe(404);
  });

  it('accepts thinkingEnabled and reasoningEffort in request body', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'nonexistent-chat',
          prompt: 'Hello',
          thinkingEnabled: true,
          reasoningEffort: 'high',
        }),
      })
    );

    // Should reach the chat ownership check (404), not a schema validation error (422)
    expect(response.status).toBe(404);
  });

  it('accepts legacy requests without thinkingVisibility', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'nonexistent-chat', prompt: 'Hello' }),
      })
    );

    // Should reach the chat ownership check (404), not a schema validation error
    expect(response.status).toBe(404);
  });

  it('does not persist stateless-loop providerState to the database', async () => {
    const chatSetCalls: Array<Record<string, unknown>> = [];
    const createdMessages: Array<Record<string, unknown>> = [];

    const STATELESS_LOOP_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'test-model',
      systemPromptHash: 'none',
      toolsetHash: 'abc123',
      loopMessages: [{ role: 'user', content: 'Hello' }],
    });

    await mock.module('../../../src/services/chat-service', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield { type: 'assistant_text_delta', text: 'Hi' };
            yield { type: 'turn_completed', providerState: STATELESS_LOOP_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/message-service', () => ({
      createMessage: (msg: Record<string, unknown>) => {
        createdMessages.push({ ...msg });
        return Promise.resolve();
      },
      loadRichChatHistory: () => Promise.resolve([]),
      loadChatHistory: () => Promise.resolve([]),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    const makeWhere = (): Record<string, unknown> => ({
      execute: () => Promise.resolve(),
      executeTakeFirst: () => Promise.resolve(null),
      where: () => makeWhere(),
    });

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({ select: () => makeWhere() }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({
          set: (values: Record<string, unknown>) => {
            chatSetCalls.push({ ...values });
            return makeWhere();
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
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hello', model: 'test-model' }),
      })
    );

    await response.text();

    // The AI message row must have providerState = null (not the stateless-loop state)
    const aiMessage = createdMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    expect(aiMessage?.providerState).toBeNull();

    // chats.lastProviderState must never be set to a non-null value
    const durableUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState !== null
    );
    expect(durableUpdate).toBeUndefined();
  });

  it('returns 503 when model catalog is not configured', async () => {
    // Mock getGeminiModelCatalog to return unconfigured state
    await mock.module('../../../src/services/gemini/catalog', () => ({
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
      clearGeminiModelCatalog: () => {},
    }));

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
      clearGeminiModelCatalog: () => {},
    }));

    // Mock DB to return a valid chat owned by our test user
    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve({ userId: TEST_USER.id }),
            }),
          }),
        }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({
          set: () => ({ where: () => ({ execute: () => Promise.resolve() }) }),
        }),
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
    const createdMessages: Array<Record<string, unknown>> = [];

    // A stateless-loop state has no cursor → mode becomes 'replay' in context_info
    const STATELESS_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      loopMessages: [],
    });

    await mock.module('../../../src/services/chat-service', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/registry', () => ({
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
            };
            yield { type: 'assistant_text_delta', text: 'Hello' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/message-service', () => ({
      createMessage: (msg: Record<string, unknown>) => {
        createdMessages.push({ ...msg });
        return Promise.resolve();
      },
      loadRichChatHistory: () => Promise.resolve([]),
      loadChatHistory: () => Promise.resolve([]),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    const makeWhere = (): Record<string, unknown> => ({
      execute: () => Promise.resolve(),
      executeTakeFirst: () => Promise.resolve(null),
      where: () => makeWhere(),
    });

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({ select: () => makeWhere() }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeWhere() }),
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

    const rawText = await response.text();

    // Parse SSE lines
    const sseEvents = rawText
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => {
        try {
          return JSON.parse(block.replace(/^data: /, '')) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);

    // Assert fallback_notice is emitted
    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice).toMatchObject({
      type: 'fallback_notice',
      from: 'stateful',
      to: 'replay',
    });

    // Assert context_info is emitted with mode=replay (no cursor in stateless-loop)
    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo).toMatchObject({ type: 'context_info', mode: 'replay' });
  });
});
