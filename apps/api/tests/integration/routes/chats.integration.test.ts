import { describe, expect, it, afterEach, beforeAll } from 'bun:test';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';
import { buildPersistedContextSnapshot } from '../../../src/services/providers/context-policy';
import {
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../src/services/providers/types';

const TEST_USER = {
  id: 'test-user-chats',
  name: 'Chat User',
  email: 'chats@mangostudio.test',
};

beforeAll(async () => {
  // Seed test user so chats.userId FK constraint is satisfied
  await getDb()
    .insertInto('user')
    .values({
      id: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
      emailVerified: 0,
      image: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .execute();
});

let restoreAuth: (() => void) | null = null;
let previousOpenAICompatibleProvider: AIProvider | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  if (previousOpenAICompatibleProvider) {
    registerProvider(previousOpenAICompatibleProvider);
  }
  previousOpenAICompatibleProvider = null;
});

function registerSummaryProvider(summaryText: string) {
  try {
    previousOpenAICompatibleProvider = getProvider('openai-compatible');
  } catch {
    previousOpenAICompatibleProvider = null;
  }

  registerProvider({
    providerType: 'openai-compatible',
    generateText: () => Promise.resolve({ text: summaryText }),
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  });
}

async function insertSummaryConnector(modelId: string) {
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `summary-connector-${modelId}-${Date.now()}`,
      name: `Summary ${modelId}`,
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: 'test',
      updatedAt: Date.now(),
      lastValidatedAt: Date.now(),
      lastValidationError: null,
      enabledModels: JSON.stringify([modelId]),
      userId: TEST_USER.id,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
}

describe('GET /chats', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(new Request('http://localhost/chats'));
    expect(response.status).toBe(401);
  });

  it('returns chats array for authenticated user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/chats'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns persisted context info without provider internals', async () => {
    const db = getDb();
    const chatId = `context-list-${Date.now()}`;
    const lastContextState = JSON.stringify(
      buildPersistedContextSnapshot(
        {
          estimatedInputTokens: 90_000,
          contextLimit: 100_000,
          estimatedUsageRatio: 0.9,
          mode: 'replay',
        },
        123456
      )
    );

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Context Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
        lastContextState,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/chats'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<Record<string, unknown>>;
    const chat = body.find((item) => item.id === chatId);

    expect(chat?.contextInfo).toMatchObject({
      estimatedInputTokens: 90_000,
      contextLimit: 100_000,
      estimatedUsageRatio: 0.9,
      mode: 'replay',
      severity: 'warning',
    });
    expect(chat).not.toHaveProperty('lastProviderState');
    expect(chat).not.toHaveProperty('lastContextState');
  });
});

describe('POST /chats', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Chat' }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('returns 422 when title is missing', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(422);
  });

  it('creates a chat and returns server-generated id', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Chat' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(typeof body['id']).toBe('string');
    expect((body['id'] as string).length).toBeGreaterThan(0);
  });

  it('does not accept client-supplied id in body', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const clientId = 'client-supplied-id';
    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Chat', id: clientId }),
      })
    );

    // Should succeed but the body schema ignores the id field — server generates its own
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(typeof body['id']).toBe('string');
    expect(body['id']).not.toBe(clientId);
  });
});

describe('DELETE /chats/:id', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(
      new Request('http://localhost/chats/some-id', { method: 'DELETE' })
    );
    expect(response.status).toBe(401);
  });

  it('deletes an owned chat and returns success', async () => {
    const db = getDb();
    const chatId = `delete-target-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'To Be Deleted',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}`, { method: 'DELETE' })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });

    const row = await db
      .selectFrom('chats')
      .selectAll()
      .where('id', '=', chatId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('returns success even when chat does not exist (no-op delete)', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/nonexistent-chat-id', { method: 'DELETE' })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });
  });
});

describe('PUT /chats/:id', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(
      new Request('http://localhost/chats/some-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('updates a chat title and returns success', async () => {
    const db = getDb();
    const chatId = `update-target-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Original Title',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });

    const row = await db
      .selectFrom('chats')
      .selectAll()
      .where('id', '=', chatId)
      .executeTakeFirst();
    expect(row?.title).toBe('Updated Title');
  });

  it('returns 422 when body is missing required schema fields', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/some-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );

    // Elysia returns 400 on body parse errors, 422 on schema validation errors
    expect([400, 422]).toContain(response.status);
  });
});

describe('POST /chats/:id/compact', () => {
  it('compacts a chat into a summary message without removing original history', async () => {
    registerSummaryProvider('Compact summary');
    await insertSummaryConnector('summary-model');

    const db = getDb();
    const chatId = `compact-${Date.now()}`;
    const base = Date.now();

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Compact Me',
        createdAt: base,
        updatedAt: base,
        model: null,
        textModel: 'summary-model',
        userId: TEST_USER.id,
        lastProviderState: 'stale-cursor',
      })
      .execute();

    await db
      .insertInto('messages')
      .values([
        {
          id: `compact-user-${chatId}`,
          chatId,
          role: 'user',
          text: 'Summarize this discussion',
          timestamp: base + 1,
          isGenerating: 0,
          interactionMode: 'chat',
        },
        {
          id: `compact-ai-${chatId}`,
          chatId,
          role: 'ai',
          text: 'Here is the long answer',
          timestamp: base + 2,
          isGenerating: 0,
          interactionMode: 'chat',
        },
      ])
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'summary-model' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chatId: string;
      summaryMessageId: string;
      contextInfo: Record<string, unknown> | null;
    };
    expect(body.chatId).toBe(chatId);
    expect(body.contextInfo).toMatchObject({ mode: 'compacted' });

    const messages = await db
      .selectFrom('messages')
      .select(['text', 'parts'])
      .where('chatId', '=', chatId)
      .orderBy('timestamp', 'asc')
      .execute();

    expect(messages).toHaveLength(3);
    expect(messages[0]?.text).toBe('Summarize this discussion');
    expect(messages[1]?.text).toBe('Here is the long answer');
    expect(messages[2]?.text).toBe('Compact summary');
    expect(messages[2]?.parts).toContain('chat_compacted');

    const chat = await db
      .selectFrom('chats')
      .select(['lastProviderState', 'lastContextState'])
      .where('id', '=', chatId)
      .executeTakeFirst();

    expect(chat?.lastProviderState).toBeNull();
    expect(chat?.lastContextState).toContain('compacted');
  });
});

describe('POST /chats/:id/summarize-to-new-chat', () => {
  it('creates a new chat seeded with a summary and keeps the source chat intact', async () => {
    registerSummaryProvider('Handoff summary');
    await insertSummaryConnector('summary-model-2');

    const db = getDb();
    const sourceChatId = `handoff-${Date.now()}`;
    const base = Date.now();

    await db
      .insertInto('chats')
      .values({
        id: sourceChatId,
        title: 'Source Chat',
        createdAt: base,
        updatedAt: base,
        model: null,
        textModel: 'summary-model-2',
        imageModel: 'image-model',
        lastUsedMode: 'chat',
        userId: TEST_USER.id,
      })
      .execute();

    await db
      .insertInto('messages')
      .values([
        {
          id: `handoff-user-${sourceChatId}`,
          chatId: sourceChatId,
          role: 'user',
          text: 'Move this chat forward',
          timestamp: base + 1,
          isGenerating: 0,
          interactionMode: 'chat',
        },
        {
          id: `handoff-ai-${sourceChatId}`,
          chatId: sourceChatId,
          role: 'ai',
          text: 'Previous answer',
          timestamp: base + 2,
          isGenerating: 0,
          interactionMode: 'chat',
        },
      ])
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${sourceChatId}/summarize-to-new-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'summary-model-2' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chatId: string;
      summaryMessageId: string;
      contextInfo: Record<string, unknown> | null;
    };
    expect(body.chatId).not.toBe(sourceChatId);
    expect(body.contextInfo).toMatchObject({ mode: 'compacted' });

    const sourceMessages = await db
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', sourceChatId)
      .execute();
    expect(sourceMessages).toHaveLength(2);

    const newChat = await db
      .selectFrom('chats')
      .select(['id', 'title', 'textModel', 'imageModel'])
      .where('id', '=', body.chatId)
      .executeTakeFirst();
    expect(newChat).toMatchObject({
      id: body.chatId,
      title: 'Source Chat',
      textModel: 'summary-model-2',
      imageModel: 'image-model',
    });

    const newMessages = await db
      .selectFrom('messages')
      .select(['text', 'parts'])
      .where('chatId', '=', body.chatId)
      .execute();
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0]?.text).toBe('Handoff summary');
    expect(newMessages[0]?.parts).toContain('summary_handoff');
  });
});

describe('GET /chats/:id/messages', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(new Request('http://localhost/chats/some-id/messages'));
    expect(response.status).toBe(401);
  });

  it('returns 404 when chat does not belong to the user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/nonexistent-chat/messages')
    );

    expect(response.status).toBe(404);
  });

  it('returns messages array and nextCursor for an owned chat', async () => {
    const db = getDb();
    const chatId = `messages-target-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Messages Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const now = Date.now();
    await db
      .insertInto('messages')
      .values([
        {
          id: `msg-a-${chatId}`,
          chatId,
          role: 'user',
          text: 'Hello',
          timestamp: now,
          isGenerating: 0,
          interactionMode: 'chat',
        },
        {
          id: `msg-b-${chatId}`,
          chatId,
          role: 'ai',
          text: 'World',
          timestamp: now + 1,
          isGenerating: 0,
          interactionMode: 'chat',
        },
      ])
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/messages?limit=50`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2);
    expect(body.nextCursor).toBeNull();
  });

  it('returns persisted context info on the first messages page', async () => {
    const db = getDb();
    const chatId = `messages-context-${Date.now()}`;
    const lastContextState = JSON.stringify(
      buildPersistedContextSnapshot(
        {
          estimatedInputTokens: 12_000,
          contextLimit: 65_536,
          estimatedUsageRatio: 12_000 / 65_536,
          mode: 'replay',
        },
        123456
      )
    );

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Messages Context Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
        lastContextState,
      })
      .execute();

    await db
      .insertInto('messages')
      .values({
        id: `msg-context-${chatId}`,
        chatId,
        role: 'ai',
        text: 'Context response',
        timestamp: Date.now(),
        isGenerating: 0,
        interactionMode: 'chat',
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/messages?limit=50`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { contextInfo?: Record<string, unknown> | null };
    expect(body.contextInfo).toMatchObject({
      estimatedInputTokens: 12_000,
      contextLimit: 65_536,
      mode: 'replay',
      severity: 'normal',
    });
  });

  it('returns nextCursor when results exceed the limit', async () => {
    const db = getDb();
    const chatId = `paginated-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Paginated Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const base = Date.now();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `pagmsg-${chatId}-${i}`,
      chatId,
      role: 'user' as const,
      text: `Message ${i}`,
      timestamp: base + i,
      isGenerating: 0 as const,
      interactionMode: 'chat' as const,
    }));
    await db.insertInto('messages').values(rows).execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    // Fetch only 2 of 3 messages to trigger cursor
    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/messages?limit=2`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[]; nextCursor: string | null };
    expect(body.messages.length).toBe(2);
    expect(body.nextCursor).not.toBeNull();
  });
});
