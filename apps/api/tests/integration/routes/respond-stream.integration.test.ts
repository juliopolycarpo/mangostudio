import { describe, expect, it, mock, afterEach } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';
import {
  verifyChatOwnership,
  listByUserId,
  getById,
  createChat,
  updateChat,
  deleteChat,
} from '../../../src/modules/chats/infrastructure/chat-repository';
import {
  getProviderForModel,
  getProvider,
  registerProvider,
} from '../../../src/services/providers/registry';
import { getAllToolDefinitions, executeTool } from '../../../src/services/tools';
import * as realGeminiNs from '../../../src/services/gemini';
import type { AgentTurnRequest } from '../../../src/services/providers/types';

const TEST_USER = {
  id: 'test-user-stream',
  name: 'Stream User',
  email: 'stream@mangostudio.test',
};

// Snapshot real implementations as plain values at module-load time, before any
// test can call mock.module(). Bun's mock.module() updates live namespace bindings,
// so spreading a namespace object in afterEach would spread the already-mocked values.
// Capturing individual named exports as constants avoids that trap.
const realGetDb = getDb;
const realVerifyChatOwnership = verifyChatOwnership;
const realListByUserId = listByUserId;
const realGetById = getById;
const realCreateChat = createChat;
const realUpdateChat = updateChat;
const realDeleteChat = deleteChat;
const realGetProviderForModel = getProviderForModel;
const realGetProvider = getProvider;
const realRegisterProvider = registerProvider;
const realGetAllToolDefinitions = getAllToolDefinitions;
const realExecuteTool = executeTool;
// For the gemini barrel we snapshot the whole object immediately.
const realGemini = { ...realGeminiNs };

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  // Restore all mocked modules to prevent leakage into later test files.
  // Bun's mock.restore() does NOT revert mock.module() overrides; explicit
  // re-registration with the original values is required.
  await mock.module('../../../src/db/database', () => ({ getDb: realGetDb }));
  await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
    verifyChatOwnership: realVerifyChatOwnership,
    listByUserId: realListByUserId,
    getById: realGetById,
    createChat: realCreateChat,
    updateChat: realUpdateChat,
    deleteChat: realDeleteChat,
  }));
  await mock.module('../../../src/services/providers/registry', () => ({
    getProviderForModel: realGetProviderForModel,
    getProvider: realGetProvider,
    registerProvider: realRegisterProvider,
  }));
  await mock.module('../../../src/services/tools', () => ({
    getAllToolDefinitions: realGetAllToolDefinitions,
    executeTool: realExecuteTool,
  }));
  await mock.module('../../../src/services/gemini', () => realGemini);
});

/**
 * Creates a fully chainable Kysely-mock using a Proxy.
 * - executeTakeFirst() → firstValue  (ownership checks, single-row lookups)
 * - execute()          → []          (list queries like loadHistory)
 */
function makeChain(firstValue: unknown): Record<string, unknown> {
  const terminal = {
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(firstValue),
  };
  const proxy: Record<string, unknown> = new Proxy(terminal, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string];
      return () => proxy;
    },
  });
  return proxy;
}

describe('POST /respond/stream', () => {
  it('returns 404 when chat is not found', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

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
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

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
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

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
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

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
    const insertedMessages: Array<Record<string, unknown>> = [];

    const STATELESS_LOOP_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'test-model',
      systemPromptHash: 'none',
      toolsetHash: 'abc123',
      loopMessages: [{ role: 'user', content: 'Hello' }],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
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

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
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
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hello', model: 'test-model' }),
      })
    );

    const rawText = await response.text();

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

    // The AI message row must have providerState = null (not the stateless-loop state)
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    expect(aiMessage?.providerState).toBeNull();

    // chats.lastProviderState must never be set to a non-null value
    const durableUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState !== null
    );
    expect(durableUpdate).toBeUndefined();

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toMatchObject({ type: 'context_info', mode: 'replay' });
    expect(typeof contextInfo?.estimatedInputTokens).toBe('number');

    const contextUpdate = chatSetCalls.find((u) => typeof u.lastContextState === 'string');
    expect(contextUpdate?.lastProviderState).toBeNull();

    const persistedContext = JSON.parse(contextUpdate?.lastContextState as string) as Record<
      string,
      unknown
    >;
    expect(persistedContext).toMatchObject({ mode: 'replay', severity: 'normal' });
    expect(typeof persistedContext.estimatedInputTokens).toBe('number');
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
      clearGeminiModelCatalog: () => undefined as void,
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
      clearGeminiModelCatalog: () => undefined as void,
    }));

    // Mock DB to return a valid chat owned by our test user
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

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
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

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
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

    await mock.module('../../../src/services/providers/registry', () => ({
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
            };
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
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
    const rawText = await response.text();

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

    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice?.done).toBe(false);

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

    await mock.module('../../../src/services/providers/registry', () => ({
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
    const rawText = await response.text();

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

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo).toMatchObject({
      type: 'context_info',
      mode: 'stateful',
      estimatedInputTokens: 2048,
    });
  });

  it('emits terminal error when provider errors on tool-result continuation', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    // First iteration emits a tool call that the orchestrator will execute;
    // the second iteration (carrying tool results) fails with a turn_error.
    let iteration = 0;
    await mock.module('../../../src/services/providers/registry', () => ({
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
    const rawText = await response.text();

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

    // Must emit a terminal error event and no done event
    const errorEvent = sseEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBe('tool-result continuation failed');
    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();

    // The error-path AI message must be persisted (as an ai row for audit)
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    // Durable cursor must be cleared to prevent stale-state replay on next turn
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

    // Provider always yields a tool_call_completed without turn_completed, forcing
    // the orchestrator to exhaust the iteration ceiling on every call.
    await mock.module('../../../src/services/providers/registry', () => ({
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
    const rawText = await response.text();

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

    // Must emit system_event with event=tool_loop_exhausted
    const exhaustedEvent = sseEvents.find(
      (e) => e.type === 'system_event' && e.event === 'tool_loop_exhausted'
    );
    expect(exhaustedEvent).toBeDefined();
    expect(exhaustedEvent?.done).toBe(false);
    expect(typeof exhaustedEvent?.detail).toBe('string');

    // Must emit terminal error event (not done)
    const errorEvent = sseEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.done).toBe(true);

    // Must NOT emit a done event
    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();

    // Persisted AI message must include the system_event part
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = JSON.parse(aiMessage?.parts as string) as Array<Record<string, unknown>>;
    const exhaustedPart = parts.find(
      (p) => p.type === 'system_event' && p.event === 'tool_loop_exhausted'
    );
    expect(exhaustedPart).toBeDefined();
  });

  it('degrades from OpenAI cursor to replay on provider switch to Gemini and persists new cursor', async () => {
    const chatSetCalls: Array<Record<string, unknown>> = [];

    const OPENAI_ENVELOPE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      cursor: 'resp_abc123',
    });

    const GEMINI_ENVELOPE = JSON.stringify({
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'none',
      toolsetHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      cursor: 'interaction_xyz',
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'gemini',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (req.providerState) {
              yield { type: 'turn_error', error: 'Expected null providerState on switch' };
              return;
            }
            yield { type: 'assistant_text_delta', text: 'Hi from Gemini' };
            yield { type: 'turn_completed', providerState: GEMINI_ENVELOPE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: OPENAI_ENVELOPE }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
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
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Hello',
          model: 'gemini-2.0-flash',
        }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

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

    // Must emit fallback_notice because of provider switch
    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice).toMatchObject({
      type: 'fallback_notice',
      from: 'responses',
      to: 'replay',
    });

    // Must persist the new Gemini cursor
    const geminiUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState === GEMINI_ENVELOPE
    );
    expect(geminiUpdate).toBeDefined();
  });

  it('uses Gemini cursor on subsequent turn after provider switch', async () => {
    const GEMINI_ENVELOPE = JSON.stringify({
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'none',
      toolsetHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      cursor: 'interaction_xyz',
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'gemini',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (req.providerState !== GEMINI_ENVELOPE) {
              yield { type: 'turn_error', error: 'Expected Gemini cursor' };
              return;
            }
            yield { type: 'assistant_text_delta', text: 'Continuing' };
            yield { type: 'turn_completed', providerState: GEMINI_ENVELOPE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: GEMINI_ENVELOPE }),
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
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Next message',
          model: 'gemini-2.0-flash',
        }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

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

    const textEvent = sseEvents.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent?.text).toBe('Continuing');

    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('always replays for openai-compatible with no cross-turn cursor', async () => {
    const chatSetCalls: Array<Record<string, unknown>> = [];

    const STATELESS_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      loopMessages: [{ role: 'user', content: 'Hello' }],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (req.providerState) {
              yield { type: 'turn_error', error: 'Expected null providerState' };
              return;
            }
            yield { type: 'assistant_text_delta', text: 'Hi' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: STATELESS_STATE }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
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
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Hello',
          model: 'deepseek-chat',
        }),
      })
    );

    expect(response.status).toBe(200);
    await response.text();

    // chats.lastProviderState must never be set to a non-null value
    const durableUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState !== null
    );
    expect(durableUpdate).toBeUndefined();
  });
});
