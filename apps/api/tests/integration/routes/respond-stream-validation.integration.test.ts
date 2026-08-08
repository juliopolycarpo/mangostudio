import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { restoreAllMocks } from './_respond-stream-helpers';

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

describe('POST /respond/stream — validation', () => {
  it('returns 404 when chat is not found', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      getOwnedChat: () => Promise.resolve(undefined),
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
      getOwnedChat: () => Promise.resolve(undefined),
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
      getOwnedChat: () => Promise.resolve(undefined),
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
      getOwnedChat: () => Promise.resolve(undefined),
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
});
