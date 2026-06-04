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
 * skip predicate previously mishandled. The general-bucket route is mounted as
 * a separate plugin via `.use()`, matching how production registers feature
 * routes (e.g. `chatRoutes`) — this proves the limiter's hooks still apply
 * across the `.use()` plugin boundary, not just to inline routes. `trustProxy`
 * makes the client IP deterministic under `app.handle()`. Returns a `get`
 * closure bound to the concrete app so callers avoid Elysia's invariant type.
 */
function buildApiApp() {
  const limiter = rateLimit({ classify: classifyRateLimit, trustProxy: true });
  const chatRoutes = new Elysia().get('/chats', () => ({ ok: true }));
  const api = new Elysia({ prefix: '/api' })
    .use(errorHandler)
    .use(limiter)
    .get('/health', () => ({ status: 'ok' }))
    .group('/auth', (group) => group.get('/session', () => ({ ok: true })))
    .use(chatRoutes);
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

  /**
   * Regression: the limiter must not consume the request body. The Better Auth
   * passthrough route reads the raw `request` itself, so if the limiter's hooks
   * make Elysia eagerly parse the body, the stream is already used and auth
   * (e.g. sign-up) fails with `ERR_BODY_ALREADY_USED`.
   */
  it('leaves the request body intact for passthrough handlers', async () => {
    const limiter = rateLimit({ classify: classifyRateLimit, trustProxy: true });
    // Mirrors the auth route: hand the untouched `request` to a downstream reader.
    const authRoutes = new Elysia().group('/auth', (group) =>
      group.all('/*', async ({ request }) => ({ echo: await request.json() }))
    );
    const api = new Elysia({ prefix: '/api' }).use(errorHandler).use(limiter).use(authRoutes);
    const app = new Elysia().use(api);

    const res = await app.handle(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { ...CALLER, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'smoke@test.local' }),
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: { email: 'smoke@test.local' } });

    limiter.teardown();
  });

  /**
   * Regression: without `trustProxy` and without proxy headers (the production
   * default), the limiter must still enforce. Elysia never sets `ctx.ip`, so it
   * resolves the caller from the server socket; if that breaks, every request
   * collapses to the 'unknown' sentinel and limits silently stop applying.
   * Uses a real `listen()` server because `app.handle()` has no socket peer.
   */
  it('enforces limits by socket IP without trustProxy or proxy headers', async () => {
    const limiter = rateLimit({ classify: () => ({ name: 'tiny', max: 2, windowMs: 60_000 }) });
    const app = new Elysia().use(limiter).get('/x', () => ({ ok: true }));
    app.listen(0); // ephemeral port
    const port = (app.server as { port?: number } | null)?.port;
    const hit = async () => (await fetch(`http://localhost:${port}/x`)).status;

    expect(await hit()).toBe(200);
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(429); // third request exceeds max=2

    await app.stop();
    limiter.teardown();
  });
});
