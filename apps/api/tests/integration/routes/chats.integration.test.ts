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
});
