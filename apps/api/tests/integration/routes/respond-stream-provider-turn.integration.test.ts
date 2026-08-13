/**
 * The streaming turn against a MangoStudio-owned provider, in both shapes it
 * supports: a plain text stream, and a provider that runs its own tool loop and
 * emits `AgentEvent`s.
 *
 * These were written against Cursor, which is now deprecated and refuses every
 * turn. The pipeline they cover was never Cursor-specific, so they run against a
 * live provider id instead of being deleted — and the deprecation itself is
 * asserted at the end, on the route where it matters most.
 */

import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
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
  createTestStreamDb,
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

async function mockLegacyStreamProvider(
  streamFactory: () => AsyncIterable<StreamingChunk>,
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

  await mock.module('../../../src/services/providers/core/provider-registry', () => ({
    getProviderForModel: () =>
      Promise.resolve({
        providerType: 'openai',
        generateText: () => Promise.resolve({ text: '' }),
        generateTextStream: streamFactory,
        listModels: () => Promise.resolve([]),
        validateApiKey: () => Promise.resolve(),
        resolveApiKey: () => Promise.resolve('provider-test-key'),
      }),
  }));
}

function mockStreamDb(insertedMessages: Array<Record<string, unknown>>) {
  const dbMock = createTestStreamDb({
    userId: TEST_USER.id,
    insertedMessages,
    selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: null }),
  });

  return () => ({ getDb: () => dbMock });
}

async function mockAgentTurnProvider(
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
      providerType: 'openai' as const,
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
    providerType: 'openai',
    generateText: () => Promise.resolve({ text: '' }),
    generateAgentTurnStream: streamFactory,
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('provider-test-key'),
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

describe('POST /respond/stream — legacy text-stream provider', () => {
  it('streams provider text chunks and completes the turn', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mockLegacyStreamProvider(async function* () {
      await Promise.resolve();
      yield { type: 'text', text: 'Hi from the provider', done: false };
      yield { type: 'text', text: '', done: true };
    }, insertedMessages);
    await mock.module('../../../src/db/database', mockStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'stream-chat',
        prompt: 'Hello',
        model: 'gpt-5.2',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'text')).toMatchObject({
      type: 'text',
      text: 'Hi from the provider',
    });
    expect(sseEvents.find((event) => event.type === 'done')).toBeDefined();
  });

  it('surfaces provider internal tool calls and error chunks', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mockLegacyStreamProvider(async function* () {
      await Promise.resolve();
      yield {
        type: 'tool_call',
        toolCallId: 'tool-1',
        name: 'read_file',
        done: false,
      };
      yield { type: 'error', content: 'The provider run failed.', done: true };
    }, insertedMessages);
    await mock.module('../../../src/db/database', mockStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'stream-chat-error',
        prompt: 'Inspect the repo',
        model: 'gpt-5.2',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'system_event')).toMatchObject({
      type: 'system_event',
      event: 'openai_internal_tool_call',
      detail: 'read_file',
    });
    expect(sseEvents.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      error: 'The provider run failed.',
    });
    expect(sseEvents.find((event) => event.type === 'done')).toBeUndefined();

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    if (aiMessage) {
      const parts = parsePersistedParts(aiMessage.parts);
      expect(parts).toContainEqual({
        type: 'system_event',
        event: 'openai_internal_tool_call',
        detail: 'read_file',
      });
      expect(parts.some((part) => part.type === 'error')).toBe(true);
    }
  });
});

describe('POST /respond/stream — agent-turn provider', () => {
  it('streams a full turn with real tool_call/tool_result parts and no internal-tool system event', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    const receivedRequests: AgentTurnRequest[] = [];

    await mockAgentTurnProvider(async function* stream(req) {
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
    await mock.module('../../../src/db/database', mockStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'stream-agent-chat',
        prompt: 'What does the README say?',
        model: 'gpt-5.2',
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
    expect(receivedRequests[0]?.chatId).toBe('stream-agent-chat');

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

    await mockAgentTurnProvider(async function* stream() {
      await Promise.resolve();
      yield { type: 'assistant_text_delta', text: 'Working…' };
      yield {
        type: 'turn_error',
        error: 'The model exceeded the maximum number of tool interactions.',
      };
    }, insertedMessages);
    await mock.module('../../../src/db/database', mockStreamDb(insertedMessages));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'stream-agent-chat-error',
        prompt: 'Do work',
        model: 'gpt-5.2',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'error')).toMatchObject({
      error: 'The model exceeded the maximum number of tool interactions.',
    });
    expect(sseEvents.find((event) => event.type === 'done')).toBeUndefined();

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    expect(aiMessage).toMatchObject({ text: 'Working…', isGenerating: 0 });
    const parts = parsePersistedParts(aiMessage?.parts);
    expect(parts.some((part) => part.type === 'error')).toBe(true);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'turn_checkpoint',
        status: 'interrupted',
        reasonCode: 'provider_error',
        lastAssistantText: 'Working…',
      })
    );
  });
});

/**
 * The refusal on the route it matters most on.
 *
 * Pre-flight, before SSE headers flush, so the client gets a status and a body
 * it can branch on rather than an `error` frame inside a stream it then has to
 * unwind. The details are the point: an error message alone would leave the
 * composer with nothing to offer.
 */
describe('POST /respond/stream — deprecated provider', () => {
  it('refuses a stored cursor model with the typed reason and its action', async () => {
    await mockVerifiedChatOwnership();
    await mockNoopTools();
    await mock.module('../../../src/services/providers/catalog', () => ({
      ...realCatalog,
      getCachedModelMetadata: () => ({ providerType: 'cursor' as const, capabilities: undefined }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'deprecated-provider-chat',
        prompt: 'Keep going',
        model: 'cursor/composer-2.5',
      })
    );

    expect(response.status).toBe(503);

    const payload = (await response.json()) as {
      code?: string;
      details?: Record<string, string>;
    };
    expect(payload.code).toBe(ERROR_CODES.MODEL_PROVIDER_DEPRECATED);
    expect(payload.details).toEqual({
      reason: 'provider-deprecated',
      action: 'fork-with-external-runner',
      modelId: 'cursor/composer-2.5',
      provider: 'cursor',
      targetId: 'cursor',
    });
  });
});
