import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { StreamingChunk } from '../../../src/services/providers/types';
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

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
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
