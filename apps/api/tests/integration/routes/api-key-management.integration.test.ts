import { describe, expect, it } from 'bun:test';
import {
  API_KEY_EXPIRY_MAX_DAYS,
  API_KEY_HEADER,
  API_KEY_MAX_PER_USER,
  API_KEY_NAME_MAX_LENGTH,
  type ApiKeyScope,
  CreateApiKeyResponseSchema,
  ListApiKeysResponseSchema,
} from '@mangostudio/shared/api-keys';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import type { Elysia } from 'elysia';
import Value from 'typebox/value';
import { getApiKeyApi } from '../../../src/auth';
import { getDb } from '../../../src/db/database';
import { apiKeyRoutes } from '../../../src/modules/api-keys/http/api-key-routes';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { apiKeyGuard } from '../../../src/plugins/api-key-guard';
import { authRoutes } from '../../../src/routes/auth';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

const apiRoutes = (app: Elysia) =>
  app.group('/api', (app) =>
    app.use(apiKeyGuard).use(authRoutes).use(apiKeyRoutes).use(chatRoutes)
  );
const app = createApiTestApp(apiRoutes);

interface AuthenticatedUser {
  id: string;
  cookie: string;
}

async function signUp(): Promise<AuthenticatedUser> {
  const response = await app.handle(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `api-keys-${crypto.randomUUID()}@mangostudio.test`,
        password: 'correct-horse-battery-staple',
        name: 'API Key Tester',
      }),
    })
  );
  const payload = (await response.json()) as { user?: { id: string } };

  expect(response.status).toBe(200);
  expect(payload.user?.id).toBeString();

  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  expect(cookie).not.toBe('');

  return { id: payload.user?.id ?? '', cookie };
}

function seedApiKey(userId: string, scope: ApiKeyScope = 'full', name = 'Seeded key') {
  return getApiKeyApi().createApiKey({
    body: { userId, name, metadata: { scope } },
  });
}

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

function cookieHeaders(cookie: string, json = false): Record<string, string> {
  return {
    Cookie: cookie,
    ...(json && { 'Content-Type': 'application/json' }),
  };
}

describe('API key management', () => {
  it('creates, lists, authenticates, and revokes a key without re-exposing its secret', async () => {
    const user = await signUp();

    const createResponse = await app.handle(
      new Request('http://localhost/api/api-keys/', {
        method: 'POST',
        headers: cookieHeaders(user.cookie, true),
        body: JSON.stringify({
          name: 'Automation',
          scope: 'full',
          expiresInDays: 30,
        }),
      })
    );
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(Value.Check(CreateApiKeyResponseSchema, created)).toBe(true);
    expect(created).toMatchObject({
      summary: {
        name: 'Automation',
        scope: 'full',
        start: 'mango_',
        lastUsedAt: null,
      },
    });

    const createdKey = (created as { key: string }).key;
    const createdId = (created as { summary: { id: string } }).summary.id;
    const stored = await getDb()
      .selectFrom('apikey')
      .select(['key', 'referenceId'])
      .where('id', '=', createdId)
      .executeTakeFirstOrThrow();

    expect(stored.referenceId).toBe(user.id);
    expect(stored.key).not.toBe(createdKey);

    await enableExternalApi(user.id);
    const authenticatedResponse = await app.handle(
      new Request('http://localhost/api/chats', {
        headers: { [API_KEY_HEADER]: createdKey },
      })
    );
    expect(authenticatedResponse.status).toBe(200);

    const listResponse = await app.handle(
      new Request('http://localhost/api/api-keys/', {
        headers: cookieHeaders(user.cookie),
      })
    );
    const listed = await listResponse.json();
    const serializedList = JSON.stringify(listed);

    expect(listResponse.status).toBe(200);
    expect(Value.Check(ListApiKeysResponseSchema, listed)).toBe(true);
    expect(listed).toMatchObject({
      keys: [
        {
          id: createdId,
          name: 'Automation',
          scope: 'full',
          start: 'mango_',
        },
      ],
    });
    expect((listed as { keys: [{ lastUsedAt: string | null }] }).keys[0].lastUsedAt).toBeString();
    expect(serializedList).not.toContain(createdKey);
    expect(serializedList).not.toContain(stored.key);
    expect(serializedList).not.toContain('metadata');
    expect(serializedList).not.toContain('referenceId');

    const deleteResponse = await app.handle(
      new Request(`http://localhost/api/api-keys/${createdId}`, {
        method: 'DELETE',
        headers: cookieHeaders(user.cookie),
      })
    );
    expect(deleteResponse.status).toBe(204);
    expect(await deleteResponse.text()).toBe('');

    const revokedResponse = await app.handle(
      new Request('http://localhost/api/chats', {
        headers: { [API_KEY_HEADER]: createdKey },
      })
    );
    expect(revokedResponse.status).toBe(401);

    const listAfterRevoke = await app.handle(
      new Request('http://localhost/api/api-keys/', {
        headers: cookieHeaders(user.cookie),
      })
    );
    expect(await listAfterRevoke.json()).toEqual({ keys: [] });
  });

  it("does not list or revoke another user's key", async () => {
    const owner = await signUp();
    const otherUser = await signUp();
    const ownerKey = await getApiKeyApi().createApiKey({ body: { userId: owner.id } });

    const listResponse = await app.handle(
      new Request('http://localhost/api/api-keys/', {
        headers: cookieHeaders(otherUser.cookie),
      })
    );
    expect(await listResponse.json()).toEqual({ keys: [] });

    const deleteResponse = await app.handle(
      new Request(`http://localhost/api/api-keys/${ownerKey.id}`, {
        method: 'DELETE',
        headers: cookieHeaders(otherUser.cookie),
      })
    );
    const payload = (await deleteResponse.json()) as ApiErrorResponse;

    expect(deleteResponse.status).toBe(404);
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload.code).toBe(ERROR_CODES.NOT_FOUND);

    const ownerListResponse = await app.handle(
      new Request('http://localhost/api/api-keys/', {
        headers: cookieHeaders(owner.cookie),
      })
    );
    expect(await ownerListResponse.json()).toMatchObject({
      keys: [{ id: ownerKey.id, name: null, scope: 'read-only' }],
    });
  });

  it('enforces contract boundaries and serializes concurrent creates at the cap', async () => {
    const user = await signUp();
    const boundaryResponse = await app.handle(
      new Request('http://localhost/api/api-keys/', {
        method: 'POST',
        headers: cookieHeaders(user.cookie, true),
        body: JSON.stringify({
          name: 'a'.repeat(API_KEY_NAME_MAX_LENGTH),
          scope: 'read-only',
          expiresInDays: API_KEY_EXPIRY_MAX_DAYS,
        }),
      })
    );
    expect(boundaryResponse.status).toBe(201);
    expect(Value.Check(CreateApiKeyResponseSchema, await boundaryResponse.json())).toBe(true);

    for (let index = 0; index < API_KEY_MAX_PER_USER - 2; index += 1) {
      await seedApiKey(user.id, 'read-only', `Seeded key ${index + 1}`);
    }

    const responses = await Promise.all(
      ['Concurrent A', 'Concurrent B'].map((name) =>
        app.handle(
          new Request('http://localhost/api/api-keys/', {
            method: 'POST',
            headers: cookieHeaders(user.cookie, true),
            body: JSON.stringify({ name, scope: 'read-only' }),
          })
        )
      )
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);

    const rejected = responses.find((response) => response.status === 400);
    const payload = (await rejected?.json()) as ApiErrorResponse;
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload.code).toBe(ERROR_CODES.API_KEY_LIMIT_REACHED);

    const listResponse = await app.handle(
      new Request('http://localhost/api/api-keys/', {
        headers: cookieHeaders(user.cookie),
      })
    );
    const listed = (await listResponse.json()) as { keys: unknown[] };
    expect(listed.keys).toHaveLength(API_KEY_MAX_PER_USER);
  });

  it('rejects API-key authentication on list, create, and revoke', async () => {
    const user = await signUp();
    const seeded = await seedApiKey(user.id);
    const requests = [
      new Request('http://localhost/api/api-keys/', {
        headers: { [API_KEY_HEADER]: seeded.key },
      }),
      new Request('http://localhost/api/api-keys/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [API_KEY_HEADER]: seeded.key,
        },
        body: JSON.stringify({ name: 'Forbidden', scope: 'full' }),
      }),
      new Request(`http://localhost/api/api-keys/${seeded.id}`, {
        method: 'DELETE',
        headers: { [API_KEY_HEADER]: seeded.key },
      }),
    ];

    for (const request of requests) {
      const response = await app.handle(request);
      const payload = (await response.json()) as ApiErrorResponse;
      expect(response.status).toBe(403);
      expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
      expect(payload.code).toBe(ERROR_CODES.API_KEY_SCOPE_FORBIDDEN);
    }
  });
});
