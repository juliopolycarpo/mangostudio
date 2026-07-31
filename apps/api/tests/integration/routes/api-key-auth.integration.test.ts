import { describe, expect, it } from 'bun:test';
import type { ApiKeyScope } from '@mangostudio/shared/api-keys';
import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import { Value } from '@sinclair/typebox/value';
import { getApiKeyApi } from '../../../src/auth';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { apiKeyGuard } from '../../../src/plugins/api-key-guard';
import { authRoutes } from '../../../src/routes/auth';
import { insertTestUser, type UserFixture } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

/** Mints a real API key for `userId` via the registered @better-auth/api-key plugin. */
async function createTestApiKey(userId: string, scope: ApiKeyScope): Promise<string> {
  const created = await getApiKeyApi().createApiKey({ body: { userId, metadata: { scope } } });
  return created.key;
}

/** Enables the external API toggle for `userId` by writing app settings directly. */
async function enableExternalApi(userId: string): Promise<void> {
  const now = Date.now();
  await getDb()
    .insertInto('user_app_settings')
    .values({
      id: `external-api-settings-${userId}`,
      userId,
      settingsJson: JSON.stringify({ externalApiSettings: { enabled: true } }),
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

describe('API key authentication', () => {
  it('authenticates a full-scope key as its owner once the toggle is on', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const key = await createTestApiKey(user.id, 'full');
    const app = createApiTestApp(apiKeyGuard, chatRoutes);

    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [API_KEY_HEADER]: key },
        body: JSON.stringify({ title: 'From an API key' }),
      })
    );
    const payload = (await response.json()) as { id: string };

    expect(response.status).toBe(200);
    const createdChat = await getDb()
      .selectFrom('chats')
      .select('userId')
      .where('id', '=', payload.id)
      .executeTakeFirstOrThrow();
    expect(createdChat.userId).toBe(user.id);
  });

  it('rejects an unknown key with 401', async () => {
    const app = createApiTestApp(apiKeyGuard, chatRoutes);

    const response = await app.handle(
      new Request('http://localhost/chats', {
        headers: { [API_KEY_HEADER]: 'mango_does-not-exist' },
      })
    );
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(401);
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('rejects an expired key with 401', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const key = await createTestApiKey(user.id, 'full');
    await getDb()
      .updateTable('apikey')
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where('referenceId', '=', user.id)
      .execute();
    const app = createApiTestApp(apiKeyGuard, chatRoutes);

    const response = await app.handle(
      new Request('http://localhost/chats', { headers: { [API_KEY_HEADER]: key } })
    );
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(401);
    expect(payload.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('rejects a valid key with the toggle off (the default for a fresh user)', async () => {
    const user = await insertTestUser();
    const key = await createTestApiKey(user.id, 'full');
    const app = createApiTestApp(apiKeyGuard, chatRoutes);

    const response = await app.handle(
      new Request('http://localhost/chats', { headers: { [API_KEY_HEADER]: key } })
    );
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(403);
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload.code).toBe(ERROR_CODES.EXTERNAL_API_DISABLED);
  });

  it('forbids a read-only key on a write method but allows it on a read method', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const key = await createTestApiKey(user.id, 'read-only');
    const app = createApiTestApp(apiKeyGuard, chatRoutes);

    const writeResponse = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [API_KEY_HEADER]: key },
        body: JSON.stringify({ title: 'Should be blocked' }),
      })
    );
    const writePayload = (await writeResponse.json()) as ApiErrorResponse;

    expect(writeResponse.status).toBe(403);
    expect(writePayload.code).toBe(ERROR_CODES.API_KEY_SCOPE_FORBIDDEN);

    const readResponse = await app.handle(
      new Request('http://localhost/chats', { headers: { [API_KEY_HEADER]: key } })
    );

    expect(readResponse.status).toBe(200);
  });

  it('rejects an API key presented against the auth routes', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const key = await createTestApiKey(user.id, 'full');
    const app = createApiTestApp(apiKeyGuard, authRoutes);

    const response = await app.handle(
      new Request('http://localhost/auth/ok', { headers: { [API_KEY_HEADER]: key } })
    );
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(401);
    expect(payload.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('leaves cookie-session traffic untouched when no header is present', async () => {
    const user: UserFixture = await insertTestUser();
    const { app, restore } = createAuthenticatedApiTestApp(user, apiKeyGuard, chatRoutes);

    try {
      const response = await app.handle(new Request('http://localhost/chats'));
      expect(response.status).toBe(200);
    } finally {
      restore();
    }
  });
});
