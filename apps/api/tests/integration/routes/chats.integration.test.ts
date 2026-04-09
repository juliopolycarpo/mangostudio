import { describe, expect, it, afterEach, beforeAll } from 'bun:test';
import { chatRoutes } from '../../../src/routes/chats';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';

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

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

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

    const row = await db.selectFrom('chats').selectAll().where('id', '=', chatId).executeTakeFirst();
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

    const row = await db.selectFrom('chats').selectAll().where('id', '=', chatId).executeTakeFirst();
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
