import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  createTestStreamDb,
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

describe('POST /respond/stream — provider cursor and switching', () => {
  it('degrades from OpenAI cursor to replay on provider switch to Gemini and persists new cursor', async () => {
    const chatSetCalls: Array<Record<string, unknown>> = [];
    const insertedMessages: Array<Record<string, unknown>> = [];

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

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
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
      getAllTools: () => [],
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    const dbMock = createTestStreamDb({
      userId: TEST_USER.id,
      insertedMessages,
      chatSetCalls,
      selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: OPENAI_ENVELOPE }),
    });
    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

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
    const sseEvents = parseSseEvents(await response.text());

    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice).toMatchObject({
      type: 'fallback_notice',
      from: 'responses',
      to: 'replay',
    });

    const continuationTransition = sseEvents.find((e) => e.type === 'continuation_transition');
    expect(continuationTransition).toBeDefined();
    expect(continuationTransition).toMatchObject({
      type: 'continuation_transition',
      provider: 'gemini',
      fromProvider: 'openai',
      fromMode: 'responses',
      toMode: 'replay',
      reasonCode: 'provider_changed',
      done: false,
    });

    const geminiUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState === GEMINI_ENVELOPE
    );
    expect(geminiUpdate).toBeDefined();

    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const transitionPart = parts.find((p) => p.type === 'continuation_transition');
    expect(transitionPart).toBeDefined();
    expect(transitionPart).toMatchObject({
      type: 'continuation_transition',
      provider: 'gemini',
      fromProvider: 'openai',
      fromMode: 'responses',
      toMode: 'replay',
      reasonCode: 'provider_changed',
      recovered: true,
    });
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

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
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
      getAllTools: () => [],
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    const dbMock = createTestStreamDb({
      userId: TEST_USER.id,
      selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: GEMINI_ENVELOPE }),
    });
    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

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
    const sseEvents = parseSseEvents(await response.text());

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

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
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
      getAllTools: () => [],
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    const dbMock = createTestStreamDb({
      userId: TEST_USER.id,
      chatSetCalls,
      selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: STATELESS_STATE }),
    });
    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

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

    const durableUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState !== null
    );
    expect(durableUpdate).toBeUndefined();
  });
});
