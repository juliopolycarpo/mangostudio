import { describe, expect, it, mock, afterEach, beforeAll } from 'bun:test';
import { messageRoutes } from '../../../src/routes/messages';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';
import { verifyChatOwnership } from '../../../src/services/chat-service';

// Capture real implementation before any test can override mock.module.
// mock.restore() does NOT revert mock.module() overrides; explicit re-registration is required.
const realVerifyChatOwnership = verifyChatOwnership;

const TEST_USER = {
  id: 'test-user-messages',
  name: 'Message User',
  email: 'messages@mangostudio.test',
};

beforeAll(async () => {
  const db = getDb();
  // Seed test user so chats.userId FK constraint is satisfied
  await db
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
  // Seed test chat so messages.chatId FK constraint is satisfied
  await db
    .insertInto('chats')
    .values({
      id: 'chat-1',
      title: 'Test Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId: TEST_USER.id,
    })
    .execute();
});

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  // Restore the real chat-service module to prevent mock leakage into later test files.
  await mock.module('../../../src/services/chat-service', () => ({
    verifyChatOwnership: realVerifyChatOwnership,
  }));
});

describe('POST /messages', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(messageRoutes);
    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('returns 422 for invalid role value', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'admin', // invalid role
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(422);
  });

  it('accepts user role', async () => {
    await mock.module('../../../src/services/chat-service', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(200);
  });

  it('accepts ai role', async () => {
    await mock.module('../../../src/services/chat-service', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-2',
          chatId: 'chat-1',
          role: 'ai',
          text: 'Hello from AI',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(200);
  });

  it('returns 404 when chat is not found for the user', async () => {
    await mock.module('../../../src/services/chat-service', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'nonexistent-chat',
          role: 'user',
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(404);
  });
});

describe('GET /messages/images', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(messageRoutes);
    const response = await app.handle(new Request('http://localhost/messages/images'));
    expect(response.status).toBe(401);
  });

  it('returns gallery items and nextCursor for authenticated user', async () => {
    const db = getDb();
    const chatId = 'gallery-chat-1';
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Gallery Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    const now = Date.now();
    await db
      .insertInto('messages')
      .values({
        id: 'gallery-msg-1',
        chatId,
        role: 'ai',
        text: '',
        imageUrl: '/uploads/sample.png',
        timestamp: now,
        isGenerating: 0,
        interactionMode: 'image',
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/messages/images?limit=50'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty('nextCursor');
  });
});

describe('PUT /messages/:id', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(messageRoutes);
    const response = await app.handle(
      new Request('http://localhost/messages/some-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated' }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('returns 404 when message does not exist or belong to user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages/nonexistent-msg', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated' }),
      })
    );

    expect(response.status).toBe(404);
  });

  it('updates a message and returns success', async () => {
    const db = getDb();
    const msgId = `update-msg-${Date.now()}`;

    await db
      .insertInto('messages')
      .values({
        id: msgId,
        chatId: 'chat-1',
        role: 'user',
        text: 'Original text',
        timestamp: Date.now(),
        isGenerating: 0,
        interactionMode: 'chat',
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/messages/${msgId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated text' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });

    const row = await db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', msgId)
      .executeTakeFirst();
    expect(row?.text).toBe('Updated text');
  });
});
