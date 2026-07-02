import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import * as realCatalogNs from '../../../src/services/providers/catalog';
import type {
  AgentEvent,
  AgentTurnRequest,
  StreamingChunk,
} from '../../../src/services/providers/types';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  buildRespondStreamRequest,
  makeChain,
  mockNoopTools,
  mockVerifiedChatOwnership,
  parsePersistedParts,
  parseSseEvents,
  restoreAllMocks,
} from './_respond-stream-helpers';

const realCatalog = { ...realCatalogNs };

let TEST_USER!: UserFixture;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

let restoreAuth: (() => void) | null = null;

async function mockCursorLegacyProvider(
  streamFactory: () => AsyncIterable<StreamingChunk>
): Promise<void> {
  await mockVerifiedChatOwnership();
  await mockNoopTools();

  await mock.module('../../../src/modules/messages/infrastructure/message-repository', () => ({
    loadHistory: () => Promise.resolve([]),
    loadRichHistory: () => Promise.resolve([]),
    insertMessage: () => Promise.resolve(),
    updateMessage: () => Promise.resolve(),
    listByChatId: () => Promise.resolve([]),
    verifyMessageOwnership: () => Promise.resolve(true),
    listLegacyGalleryImages: () => Promise.resolve([]),
  }));

  await mock.module('../../../src/services/providers/core/provider-registry', () => ({
    getProviderForModel: () =>
      Promise.resolve({
        providerType: 'cursor',
        generateText: () => Promise.resolve({ text: '' }),
        generateTextStream: streamFactory,
        listModels: () => Promise.resolve([]),
        validateApiKey: () => Promise.resolve(),
        resolveApiKey: () => Promise.resolve('cursor-test-key'),
      }),
  }));
}

function mockCursorStreamDb(insertedMessages: Array<Record<string, unknown>>) {
  const dbMock: Record<string, unknown> = {
    selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: null }),
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => {
        if (table === 'messages') insertedMessages.push({ ...values });
        return { execute: () => Promise.resolve() };
      },
    }),
    updateTable: () => ({
      set: () => makeChain(undefined),
    }),
    transaction: () => ({
      execute: (callback: (trx: Record<string, unknown>) => Promise<unknown>) => callback(dbMock),
    }),
  };

  return () => ({ getDb: () => dbMock });
}

async function mockCursorAgentProvider(
  streamFactory: (req: AgentTurnRequest) => AsyncIterable<AgentEvent>,
  insertedMessages: Array<Record<string, unknown>>
): Promise<void> {
  await mockVerifiedChatOwnership();
  await mockNoopTools();

  await mock.module('../../../src/modules/messages/infrastructure/message-repository', () => ({
    loadHistory: () => Promise.resolve([]),
    loadRichHistory: () => Promise.resolve([]),
    insertMessage: (message: Record<string, unknown>) => {
      insertedMessages.push({ ...message });
      return Promise.resolve();
    },
    updateMessage: () => Promise.resolve(),
    listByChatId: () => Promise.resolve([]),
    verifyMessageOwnership: () => Promise.resolve(true),
    listLegacyGalleryImages: () => Promise.resolve([]),
  }));

  await mock.module('../../../src/services/providers/catalog', () => ({
    ...realCatalog,
    getCachedModelMetadata: () => ({
      providerType: 'cursor' as const,
      capabilities: {
        text: true,
        image: false,
        streaming: true,
        reasoning: true,
        tools: true,
        internalAgentTools: true,
        statefulContinuation: false,
      },
    }),
  }));

  const provider = {
    providerType: 'cursor',
    generateText: () => Promise.resolve({ text: '' }),
    generateAgentTurnStream: streamFactory,
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('cursor-test-key'),
  };
  await mock.module('../../../src/services/providers/core/provider-registry', () => ({
    getProvider: () => provider,
    getProviderForModel: () => Promise.resolve(provider),
  }));
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await mock.module('../../../src/services/providers/catalog', () => realCatalog);
  await restoreAllMocks();
});

describe('POST /respond/stream — cursor legacy provider', () => {
  it('streams cursor text chunks and completes the turn', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mockCursorLegacyProvider(async function* () {
      await Promise.resolve();
      yield { type: 'text', text: 'Hi from Cursor', done: false };
      yield { type: 'text', text: '', done: true };
    });
    await mock.module('../../../src/db/database', mockCursorStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'cursor-chat',
        prompt: 'Hello',
        model: 'composer-2.5',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'text')).toMatchObject({
      type: 'text',
      text: 'Hi from Cursor',
    });
    expect(sseEvents.find((event) => event.type === 'done')).toBeDefined();
  });

  it('surfaces cursor internal tool calls and provider error chunks', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mockCursorLegacyProvider(async function* () {
      await Promise.resolve();
      yield {
        type: 'tool_call',
        toolCallId: 'tool-1',
        name: 'read_file',
        done: false,
      };
      yield { type: 'error', content: 'Cursor agent run failed.', done: true };
    });
    await mock.module('../../../src/db/database', mockCursorStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'cursor-chat-error',
        prompt: 'Inspect the repo',
        model: 'composer-2.5',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'system_event')).toMatchObject({
      type: 'system_event',
      event: 'cursor_internal_tool_call',
      detail: 'read_file',
    });
    expect(sseEvents.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      error: 'Cursor agent run failed.',
    });
    expect(sseEvents.find((event) => event.type === 'done')).toBeUndefined();

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    if (aiMessage) {
      const parts = parsePersistedParts(aiMessage.parts);
      expect(parts).toContainEqual({
        type: 'system_event',
        event: 'cursor_internal_tool_call',
        detail: 'read_file',
      });
      expect(parts.some((part) => part.type === 'error')).toBe(true);
    }
  });
});

describe('POST /respond/stream — cursor agent turn provider', () => {
  it('streams a full turn with real tool_call/tool_result parts and no internal-tool system event', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    const receivedRequests: AgentTurnRequest[] = [];

    await mockCursorAgentProvider(async function* stream(req) {
      receivedRequests.push(req);
      await Promise.resolve();
      yield { type: 'reasoning_delta', text: 'Inspecting…' };
      yield { type: 'tool_call_started', callId: 'mango-tool-1', name: 'read_file' };
      yield {
        type: 'tool_call_completed',
        callId: 'mango-tool-1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      };
      yield {
        type: 'tool_result',
        callId: 'mango-tool-1',
        name: 'read_file',
        result: '# MangoStudio',
        isError: false,
      };
      yield { type: 'assistant_text_delta', text: 'The README describes MangoStudio.' };
      yield { type: 'turn_completed' };
    }, insertedMessages);
    await mock.module('../../../src/db/database', mockCursorStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'cursor-agent-chat',
        prompt: 'What does the README say?',
        model: 'composer-2.5',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'tool_call_started')).toMatchObject({
      callId: 'mango-tool-1',
      name: 'read_file',
    });
    expect(sseEvents.find((event) => event.type === 'tool_call_completed')).toMatchObject({
      callId: 'mango-tool-1',
      arguments: '{"path":"README.md"}',
    });
    expect(sseEvents.find((event) => event.type === 'tool_result')).toMatchObject({
      callId: 'mango-tool-1',
      name: 'read_file',
      result: '# MangoStudio',
      isError: false,
    });
    expect(sseEvents.find((event) => event.type === 'text')).toMatchObject({
      text: 'The README describes MangoStudio.',
    });
    expect(sseEvents.find((event) => event.type === 'system_event')).toBeUndefined();
    expect(sseEvents.find((event) => event.type === 'done')).toBeDefined();

    // Provider ran its internal loop: exactly one iteration, no fed-back results.
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]?.toolResults).toBeUndefined();
    expect(receivedRequests[0]?.chatId).toBe('cursor-agent-chat');

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    expect(parts).toContainEqual({
      type: 'tool_call',
      toolCallId: 'mango-tool-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });
    expect(parts).toContainEqual({
      type: 'tool_result',
      toolCallId: 'mango-tool-1',
      content: '# MangoStudio',
      isError: false,
    });
    expect(parts.some((part) => part.type === 'system_event')).toBe(false);
  });

  it('surfaces provider turn_error as a persisted error response', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mockCursorAgentProvider(async function* stream() {
      await Promise.resolve();
      yield { type: 'assistant_text_delta', text: 'Working…' };
      yield {
        type: 'turn_error',
        error: 'The model exceeded the maximum number of tool interactions.',
      };
    }, insertedMessages);
    await mock.module('../../../src/db/database', mockCursorStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'cursor-agent-chat-error',
        prompt: 'Do work',
        model: 'composer-2.5',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'error')).toMatchObject({
      error: 'The model exceeded the maximum number of tool interactions.',
    });
    expect(sseEvents.find((event) => event.type === 'done')).toBeUndefined();

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    if (aiMessage) {
      const parts = parsePersistedParts(aiMessage.parts);
      expect(parts.some((part) => part.type === 'error')).toBe(true);
    }
  });
});
