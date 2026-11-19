import { describe, expect, it, spyOn } from 'bun:test';

import type { ApiKeyScope } from '@mangostudio/shared/api-keys';
import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import Value from 'typebox/value';

import { getApiKeyApi, getAuth } from '../../../src/auth';
import { getDb } from '../../../src/db/database';
import { apiKeyRoutes } from '../../../src/modules/api-keys/http/api-key-routes';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { apiKeyGuard } from '../../../src/plugins/api-key-guard';
import { requireAuth } from '../../../src/plugins/auth-middleware';
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

/**
 * Better Auth's api-key plugin runs the same validation for the session lookup
 * (`getSession`'s before-hook) and for `verifyApiKey`, and each run writes the
 * key row and consumes one use of a `remaining` quota. A request that validated
 * twice therefore spent two uses. The quota is the observable: it must fall by
 * exactly one per authenticated request.
 */
describe('API key validation runs once per request', () => {
  const QUOTA = 10;

  /** Mints a full-scope key with a use quota; `remaining` is a server-only option. */
  async function createQuotaKey(userId: string): Promise<{ key: string; id: string }> {
    const created = await getAuth().api.createApiKey({
      body: { userId, remaining: QUOTA, metadata: { scope: 'full' } },
    });
    return { key: created.key, id: created.id };
  }

  async function readRemaining(keyId: string): Promise<number | null> {
    const row = await getDb()
      .selectFrom('apikey')
      .select('remaining')
      .where('id', '=', keyId)
      .executeTakeFirstOrThrow();
    return row.remaining;
  }

  it('spends one use of the quota per request through the guard and the session derive', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const { key, id } = await createQuotaKey(user.id);
    const app = createApiTestApp(apiKeyGuard, chatRoutes);

    for (let sent = 1; sent <= 3; sent++) {
      const response = await app.handle(
        new Request('http://localhost/chats', { headers: { [API_KEY_HEADER]: key } })
      );
      expect(response.status).toBe(200);
      expect(await readRemaining(id)).toBe(QUOTA - sent);
    }
  });

  it('calls verifyApiKey once per request and never asks getSession to validate the key', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const { key } = await createQuotaKey(user.id);
    const app = createApiTestApp(apiKeyGuard, chatRoutes);
    const api = getAuth().api;
    const verifySpy = spyOn(api, 'verifyApiKey');
    const sessionSpy = spyOn(api, 'getSession');

    try {
      for (let sent = 1; sent <= 3; sent++) {
        await app.handle(
          new Request('http://localhost/chats', { headers: { [API_KEY_HEADER]: key } })
        );
        expect(verifySpy).toHaveBeenCalledTimes(sent);
      }
      expect(sessionSpy).not.toHaveBeenCalled();
    } finally {
      verifySpy.mockRestore();
      sessionSpy.mockRestore();
    }
  });

  it('spends one use on a route the guard does not verify (key management)', async () => {
    const user = await insertTestUser();
    const { key, id } = await createQuotaKey(user.id);
    const app = createApiTestApp(apiKeyGuard, apiKeyRoutes);

    const response = await app.handle(
      new Request('http://localhost/api-keys', { headers: { [API_KEY_HEADER]: key } })
    );

    // A valid key is still refused here (cookie session only), after one validation.
    expect(response.status).toBe(403);
    expect(((await response.json()) as ApiErrorResponse).code).toBe(
      ERROR_CODES.API_KEY_SCOPE_FORBIDDEN
    );
    expect(await readRemaining(id)).toBe(QUOTA - 1);
  });

  it('publishes the key owner and an api-key session to the handler', async () => {
    const user = await insertTestUser();
    const { key, id } = await createQuotaKey(user.id);
    const app = createApiTestApp(
      new Elysia()
        .use(requireAuth)
        .get('/whoami', ({ user: owner, session, authenticationMethod }) => ({
          userId: owner?.id,
          email: owner?.email,
          sessionId: session?.id,
          sessionUserId: session?.userId,
          authenticationMethod,
        }))
    );

    const response = await app.handle(
      new Request('http://localhost/whoami', { headers: { [API_KEY_HEADER]: key } })
    );

    expect(await response.json()).toEqual({
      userId: user.id,
      email: user.email,
      sessionId: id,
      sessionUserId: user.id,
      authenticationMethod: 'api-key',
    });
  });

  it('rejects a disabled key with 401 and leaves its quota alone', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const { key, id } = await createQuotaKey(user.id);
    await getDb().updateTable('apikey').set({ enabled: 0 }).where('id', '=', id).execute();
    const app = createApiTestApp(apiKeyGuard, chatRoutes);

    const response = await app.handle(
      new Request('http://localhost/chats', { headers: { [API_KEY_HEADER]: key } })
    );

    expect(response.status).toBe(401);
    expect(await readRemaining(id)).toBe(QUOTA);
  });

  it('answers 401 once the quota is spent', async () => {
    const user = await insertTestUser();
    await enableExternalApi(user.id);
    const { key, id } = await createQuotaKey(user.id);
    await getDb().updateTable('apikey').set({ remaining: 1 }).where('id', '=', id).execute();
    const app = createApiTestApp(apiKeyGuard, chatRoutes);
    const send = () =>
      app.handle(new Request('http://localhost/chats', { headers: { [API_KEY_HEADER]: key } }));

    expect((await send()).status).toBe(200);
    expect(await readRemaining(id)).toBe(0);
    expect((await send()).status).toBe(401);
  });

  it('keeps cookie sessions on getSession and out of key verification', async () => {
    const user: UserFixture = await insertTestUser();
    const { app, restore } = createAuthenticatedApiTestApp(user, apiKeyGuard, chatRoutes);
    const verifySpy = spyOn(getAuth().api, 'verifyApiKey');

    try {
      expect((await app.handle(new Request('http://localhost/chats'))).status).toBe(200);
      expect(verifySpy).not.toHaveBeenCalled();
    } finally {
      verifySpy.mockRestore();
      restore();
    }
  });
});
