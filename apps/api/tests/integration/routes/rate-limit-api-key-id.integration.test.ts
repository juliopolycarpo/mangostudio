import { describe, expect, it } from 'bun:test';

import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';

import { getDb } from '../../../src/db/database';
import { createApiKeyGuard } from '../../../src/plugins/api-key-guard';
import { createApiKeyVerifier } from '../../../src/plugins/api-key-verification';
import { errorHandler } from '../../../src/plugins/error-handler';
import { rateLimit } from '../../../src/plugins/rate-limit';
import { createRateLimitClientIdResolver } from '../../../src/plugins/rate-limit-client-id';
import { classifyRateLimit, RATE_LIMIT_BUCKETS } from '../../../src/plugins/rate-limit-policy';
import { insertTestUser } from '../../support/factories';
import { FakeApiKeyVerifyApi } from '../../support/fake-api-key-verify-api';

const CALLER = { 'x-forwarded-for': '198.51.100.7' };
const TINY_API_KEY_BUCKET = { name: RATE_LIMIT_BUCKETS.apiKey.name, max: 3, windowMs: 60_000 };

/** Enables the external API toggle so `apiKeyGuard` lets a verified key through. */
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

/**
 * The production wiring order (errorHandler, limiter, guard) with a fake Better
 * Auth port and a three-request api-key bucket. The limiter and the guard share
 * one verifier, exactly as `app.ts` wires them.
 */
async function buildKeyedApp() {
  const user = await insertTestUser();
  await enableExternalApi(user.id);
  const keyApi = new FakeApiKeyVerifyApi()
    .register('mango_key_alpha', 'key-id-alpha', user.id)
    .register('mango_key_bravo', 'key-id-bravo', user.id);
  const verifier = createApiKeyVerifier(() => keyApi);
  const limiter = rateLimit({
    classify: (path, headers, method) => {
      const bucket = classifyRateLimit(path, headers, method);
      return bucket?.name === TINY_API_KEY_BUCKET.name ? TINY_API_KEY_BUCKET : bucket;
    },
    trustProxy: true,
    resolveClientId: createRateLimitClientIdResolver(verifier),
  });
  const routes = new Elysia()
    .get('/chats', () => ({ ok: true }))
    .get('/api-keys', () => ({ ok: true }))
    .post('/echo', { parse: 'none' }, async ({ request }) => ({ echo: await request.json() }));
  const api = new Elysia({ prefix: '/api' })
    .use(errorHandler)
    .use(limiter)
    .use(createApiKeyGuard(verifier))
    .use(routes);
  const app = new Elysia().use(api);

  const send = (path: string, apiKey?: string, init: RequestInit = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          ...CALLER,
          ...(init.headers as Record<string, string> | undefined),
          ...(apiKey === undefined ? {} : { [API_KEY_HEADER]: apiKey }),
        },
      })
    );
  return { send, keyApi, teardown: limiter.teardown };
}

describe('api-key bucket keyed by verified key id', () => {
  it('counts distinct keys on one IP independently', async () => {
    const { send, teardown } = await buildKeyedApp();

    for (let i = 0; i < TINY_API_KEY_BUCKET.max; i++) {
      expect((await send('/api/chats', 'mango_key_alpha')).status).toBe(200);
    }
    const limited = await send('/api/chats', 'mango_key_alpha');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe(ERROR_CODES.RATE_LIMITED);

    // Same IP, other key: its own counter, untouched by alpha's exhaustion.
    for (let i = 0; i < TINY_API_KEY_BUCKET.max; i++) {
      expect((await send('/api/chats', 'mango_key_bravo')).status).toBe(200);
    }
    expect((await send('/api/chats', 'mango_key_bravo')).status).toBe(429);

    // And the general bucket for cookie traffic on the same IP.
    expect((await send('/api/chats')).status).toBe(200);

    teardown();
  });

  it('verifies a valid key once per request across limiter and guard', async () => {
    const { send, keyApi, teardown } = await buildKeyedApp();

    for (let i = 1; i <= 3; i++) {
      expect((await send('/api/chats', 'mango_key_alpha')).status).toBe(200);
      expect(keyApi.verifiedKeys).toHaveLength(i);
    }
    expect(keyApi.verifiedKeys).toEqual(Array(3).fill('mango_key_alpha'));

    teardown();
  });

  it('keeps rotating garbage keys on one IP counter and rejects them 401 until it fills', async () => {
    const { send, keyApi, teardown } = await buildKeyedApp();

    for (let i = 0; i < TINY_API_KEY_BUCKET.max; i++) {
      // Not 200: the guard rejects the unverified key, and the attempt counts.
      expect((await send('/api/chats', `garbage_rotating_key_${i}`)).status).toBe(401);
    }
    const limited = await send('/api/chats', `garbage_rotating_key_${TINY_API_KEY_BUCKET.max}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    // One verification per attempt, no second one from the guard.
    expect(keyApi.verifiedKeys).toHaveLength(TINY_API_KEY_BUCKET.max + 1);

    teardown();
  });

  it('does not let garbage keys from an IP spend a valid key counter', async () => {
    const { send, teardown } = await buildKeyedApp();

    for (let i = 0; i <= TINY_API_KEY_BUCKET.max; i++) {
      await send('/api/chats', `garbage_rotating_key_${i}`);
    }
    expect((await send('/api/chats', 'garbage_after_limit')).status).toBe(429);

    expect((await send('/api/chats', 'mango_key_alpha')).status).toBe(200);

    teardown();
  });

  it('keeps the IP key where the guard does not verify the key', async () => {
    const { send, keyApi, teardown } = await buildKeyedApp();

    // Key-management routes defer to requireCookieAuth: neither hook verifies,
    // so a valid key cannot pick its own counter there.
    for (let i = 0; i < TINY_API_KEY_BUCKET.max; i++) {
      expect((await send('/api/api-keys', 'mango_key_alpha')).status).toBe(200);
    }
    expect((await send('/api/api-keys', 'mango_key_bravo')).status).toBe(429);
    expect(keyApi.verifiedKeys).toEqual([]);

    teardown();
  });

  /**
   * Regression for the constraint the issue names: resolving the key id before
   * the route runs must not consume the request body, or a passthrough handler
   * fails with `ERR_BODY_ALREADY_USED`.
   */
  it('leaves the request body intact for the route after verifying the key', async () => {
    const { send, teardown } = await buildKeyedApp();

    const response = await send('/api/echo', 'mango_key_alpha', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echo: { hello: 'world' } });

    teardown();
  });
});
