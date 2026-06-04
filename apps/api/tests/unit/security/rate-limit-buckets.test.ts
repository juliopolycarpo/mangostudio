import { describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import { type RateLimitBucket, rateLimit } from '../../../src/plugins/rate-limit';

const CALLER = { 'x-forwarded-for': '203.0.113.5' };

/**
 * Builds a test app whose `classify` sorts paths into per-prefix buckets.
 * `trustProxy` makes the client IP deterministic under `app.handle()`, which
 * otherwise leaves `ctx.ip` undefined. Returns a `get` closure bound to the
 * concrete app so callers avoid Elysia's invariant instance type.
 */
function buildApp(classify?: (path: string) => RateLimitBucket | null) {
  const limiter = rateLimit({ max: 2, windowMs: 60_000, trustProxy: true, classify });
  const app = new Elysia()
    .use(limiter)
    .get('/health', () => ({ ok: true }))
    .get('/auth/session', () => ({ ok: true }))
    .get('/chats', () => ({ ok: true }));
  const get = (path: string) =>
    app.handle(new Request(`http://localhost${path}`, { headers: CALLER }));
  return { get, teardown: limiter.teardown };
}

describe('rate-limit default bucket', () => {
  it('limits a path once the default bucket max is exceeded', async () => {
    const { get, teardown } = buildApp();

    expect((await get('/chats')).status).toBe(200);
    expect((await get('/chats')).status).toBe(200);
    expect((await get('/chats')).status).toBe(429);

    teardown();
  });

  it('returns an ApiErrorResponse body with a Retry-After header when limited', async () => {
    const { get, teardown } = buildApp();

    await get('/chats');
    await get('/chats');
    const limited = await get('/chats');

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(limited.headers.get('content-type')).toContain('application/json');
    const body = (await limited.json()) as { error: string; code: string };
    expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(body.error.length).toBeGreaterThan(0);

    teardown();
  });
});

describe('rate-limit buckets', () => {
  it('counts each bucket independently so one cannot exhaust another', async () => {
    const buckets: Record<string, RateLimitBucket> = {
      '/health': { name: 'health', max: 5, windowMs: 60_000 },
      '/auth/session': { name: 'auth', max: 3, windowMs: 60_000 },
      '/chats': { name: 'general', max: 2, windowMs: 60_000 },
    };
    const { get, teardown } = buildApp((path) => buckets[path] ?? buckets['/chats']);

    // Exhaust the general bucket.
    expect((await get('/chats')).status).toBe(200);
    expect((await get('/chats')).status).toBe(200);
    expect((await get('/chats')).status).toBe(429);

    // Other buckets are untouched by the general exhaustion.
    expect((await get('/health')).status).toBe(200);
    expect((await get('/auth/session')).status).toBe(200);

    teardown();
  });

  it('exempts a path entirely when classify returns null', async () => {
    const { get, teardown } = buildApp((path) =>
      path === '/health' ? null : { name: 'general', max: 1, windowMs: 60_000 }
    );

    // Far beyond any max — never limited because it is exempt.
    for (let i = 0; i < 10; i++) {
      expect((await get('/health')).status).toBe(200);
    }

    teardown();
  });

  it('reflects the per-bucket max in X-RateLimit-Limit headers', async () => {
    const { get, teardown } = buildApp((path) =>
      path === '/health'
        ? { name: 'health', max: 50, windowMs: 60_000 }
        : { name: 'general', max: 2, windowMs: 60_000 }
    );

    const health = await get('/health');
    const chats = await get('/chats');

    expect(health.headers.get('x-ratelimit-limit')).toBe('50');
    expect(chats.headers.get('x-ratelimit-limit')).toBe('2');

    teardown();
  });

  /**
   * Regression: a blank leading X-Forwarded-For hop (e.g. ",9.9.9.9") must not
   * resolve to an empty client IP and shadow a usable fallback header. An empty
   * IP is treated as unidentifiable and skipped, so a crafted header would
   * otherwise bypass limiting under `trustProxy`.
   */
  it('falls back past a blank X-Forwarded-For hop instead of skipping the limiter', async () => {
    const limiter = rateLimit({ max: 2, windowMs: 60_000, trustProxy: true });
    const app = new Elysia().use(limiter).get('/chats', () => ({ ok: true }));
    // The blank first hop must yield to the x-real-ip fallback, not an empty IP.
    const get = () =>
      app.handle(
        new Request('http://localhost/chats', {
          headers: { 'x-forwarded-for': ',9.9.9.9', 'x-real-ip': '5.5.5.5' },
        })
      );

    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429); // resolved via x-real-ip, so limiting applies

    limiter.teardown();
  });

  /**
   * Defense-in-depth: an implausibly long forwarded value must not become a
   * giant store key. It is rejected and the limiter falls through to the
   * x-real-ip fallback, which still identifies the caller and enforces limits.
   */
  it('rejects an oversized X-Forwarded-For value and falls back', async () => {
    const limiter = rateLimit({ max: 2, windowMs: 60_000, trustProxy: true });
    const app = new Elysia().use(limiter).get('/chats', () => ({ ok: true }));
    const get = () =>
      app.handle(
        new Request('http://localhost/chats', {
          headers: { 'x-forwarded-for': '9'.repeat(500), 'x-real-ip': '5.5.5.5' },
        })
      );

    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429); // counted under x-real-ip, not the 500-char value

    limiter.teardown();
  });
});
