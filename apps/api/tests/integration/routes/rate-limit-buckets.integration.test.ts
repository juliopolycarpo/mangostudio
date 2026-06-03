import { describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import { errorHandler } from '../../../src/plugins/error-handler';
import { rateLimit } from '../../../src/plugins/rate-limit';
import { classifyRateLimit, RATE_LIMIT_BUCKETS } from '../../../src/plugins/rate-limit-policy';

const CALLER = { 'x-forwarded-for': '198.51.100.7' };

type GetFn = (path: string) => Promise<Response>;

/**
 * Mirrors the production `/api` wiring (prefix + errorHandler + the real
 * classify policy) so the test exercises the same prefixed runtime paths the
 * skip predicate previously mishandled. `trustProxy` makes the client IP
 * deterministic under `app.handle()`. Returns a `get` closure bound to the
 * concrete app so callers avoid Elysia's invariant instance type.
 */
function buildApiApp() {
  const limiter = rateLimit({ classify: classifyRateLimit, trustProxy: true });
  const api = new Elysia({ prefix: '/api' })
    .use(errorHandler)
    .use(limiter)
    .get('/health', () => ({ status: 'ok' }))
    .group('/auth', (group) => group.get('/session', () => ({ ok: true })))
    .get('/chats', () => ({ ok: true }));
  const app = new Elysia().use(api);
  const get: GetFn = (path) =>
    app.handle(new Request(`http://localhost${path}`, { headers: CALLER }));
  return { get, teardown: limiter.teardown };
}

/** Drive `path` until it returns 429, capping iterations as a safety net. */
async function exhaust(get: GetFn, path: string, cap: number): Promise<number> {
  for (let i = 0; i <= cap; i++) {
    if ((await get(path)).status === 429) return i + 1;
  }
  return -1;
}

describe('rate-limit buckets under the /api prefix', () => {
  it('rate-limits general API routes at the general bucket max', async () => {
    const { get, teardown } = buildApiApp();
    const max = RATE_LIMIT_BUCKETS.general.max;

    for (let i = 0; i < max; i++) {
      expect((await get('/api/chats')).status).toBe(200);
    }
    const limited = await get('/api/chats');
    expect(limited.status).toBe(429);

    const body = (await limited.json()) as { error: string; code: string };
    expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(limited.headers.get('retry-after')).toBeTruthy();

    teardown();
  });

  it('does not rate-limit /api/health or /api/auth/* with the general limit', async () => {
    const { get, teardown } = buildApiApp();
    const max = RATE_LIMIT_BUCKETS.general.max;

    // Saturate the general bucket from this IP.
    for (let i = 0; i <= max; i++) {
      await get('/api/chats');
    }
    expect((await get('/api/chats')).status).toBe(429);

    // Prefixed health and auth paths sit in their own buckets — still allowed.
    expect((await get('/api/health')).status).toBe(200);
    expect((await get('/api/auth/session')).status).toBe(200);

    teardown();
  });

  it('still caps /api/health and /api/auth/* at their own bucket maxima', async () => {
    const { get, teardown } = buildApiApp();

    // Their limits are higher than general but finite — a flood is bounded.
    const healthHit = await exhaust(get, '/api/health', RATE_LIMIT_BUCKETS.health.max);
    const authHit = await exhaust(get, '/api/auth/session', RATE_LIMIT_BUCKETS.auth.max);

    expect(healthHit).toBe(RATE_LIMIT_BUCKETS.health.max + 1);
    expect(authHit).toBe(RATE_LIMIT_BUCKETS.auth.max + 1);

    teardown();
  });
});
