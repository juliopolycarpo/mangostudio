import { describe, expect, it, mock, afterEach } from 'bun:test';
import { respondStreamRoutes } from '../../../src/routes/respond-stream';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'test-user-stream',
  name: 'Stream User',
  email: 'stream@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  mock.restore();
});

describe('POST /respond/stream', () => {
  it('returns 404 when chat is not found', async () => {
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
    const body = await response.json();
    expect(body).toHaveProperty('error');
  });

  it('accepts thinkingVisibility in request body without error', async () => {
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

  it('returns 503 when model catalog is not configured', async () => {
    // Mock getGeminiModelCatalog to return unconfigured state
    mock.module('../../../src/services/gemini/catalog', () => ({
      getGeminiModelCatalog: async () => ({
        configured: false,
        status: 'idle',
        allModels: [],
        textModels: [],
        imageModels: [],
        discoveredTextModels: [],
        discoveredImageModels: [],
      }),
      clearGeminiModelCatalog: () => {},
    }));

    mock.module('../../../src/services/gemini', () => ({
      getGeminiModelCatalog: async () => ({
        configured: false,
        status: 'idle',
        allModels: [],
        textModels: [],
        imageModels: [],
        discoveredTextModels: [],
        discoveredImageModels: [],
      }),
      getDefaultTextModel: () => null,
      hasTextModel: () => false,
      clearGeminiModelCatalog: () => {},
    }));

    // Mock DB to return a valid chat owned by our test user
    mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => ({ userId: TEST_USER.id }),
            }),
          }),
        }),
        insertInto: () => ({ values: () => ({ execute: async () => {} }) }),
        updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => {} }) }) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'some-chat', prompt: 'Hello' }),
      })
    );

    expect(response.status).toBe(503);
  });
});
