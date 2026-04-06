import { describe, expect, it, mock, afterEach, beforeAll } from 'bun:test';
import { messageRoutes } from '../../../src/routes/messages';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';

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

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  mock.restore();
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
});
