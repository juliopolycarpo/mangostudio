/**
 * The request lifecycle guarantees the API is wired on top of.
 *
 * Every hook in `app.ts` depends on an ordering or a scope that is never
 * written down at a call site: `requireAuth` publishes `user` from a `derive`
 * that must have run before its own `onBeforeHandle`; the rate limiter reads a
 * `clientIp` the same way and silently stops enforcing if it is missing;
 * `apiKeyGuard` is mounted once and must stay once; and the scoped guards must
 * cover their own subtree without leaking onto a sibling module.
 *
 * Those are the invariants a framework change can break while everything still
 * compiles — a widened scope turns a public route private, a narrowed one turns
 * a private route public, and a re-ordered `derive` disables the rate limiter
 * without failing a single existing assertion. Each case below drives a real
 * request and asserts the observable outcome rather than inspecting hooks.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import { getAuth } from '../../../src/auth';
import { apiKeyGuard } from '../../../src/plugins/api-key-guard';
import { requireAuth } from '../../../src/plugins/auth-middleware';
import { errorHandler } from '../../../src/plugins/error-handler';
import { rateLimit } from '../../../src/plugins/rate-limit';
import { classifyRateLimit, RATE_LIMIT_BUCKETS } from '../../../src/plugins/rate-limit-policy';
import { insertTestUser } from '../../support/factories';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

const CALLER = { 'x-forwarded-for': '203.0.113.9' };

interface SessionSpy {
  calls: number;
  restore(): void;
}

/**
 * Replace `auth.api.getSession` with a counting stub.
 *
 * The count is the assertion: `authMiddleware` is a *named* Elysia instance so
 * the framework dedupes it across the dozens of route modules that mount it,
 * and the session lookup happens once per request rather than once per module.
 */
function spyOnGetSession(session: unknown): SessionSpy {
  const auth = getAuth();
  const api = auth.api as Record<string, unknown>;
  const original = auth.api.getSession.bind(auth.api);
  const spy: SessionSpy = {
    calls: 0,
    restore: () => {
      api.getSession = original;
    },
  };

  api.getSession = () => {
    spy.calls += 1;
    return Promise.resolve(session);
  };

  return spy;
}

function sessionFor(userId: string) {
  const now = new Date();
  return {
    user: {
      id: userId,
      name: 'Lifecycle User',
      email: `${userId}@mangostudio.test`,
      createdAt: now,
      updatedAt: now,
      image: null,
      emailVerified: false,
    },
    session: {
      id: 'lifecycle-session',
      userId,
      token: 'lifecycle-token',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  };
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('derive publishes auth context before the guard runs', () => {
  it('hands a protected route the derived user, session, and method', async () => {
    const user = await insertTestUser();
    const spy = spyOnGetSession(sessionFor(user.id));
    cleanup = spy.restore;

    const app = createApiTestApp(
      new Elysia()
        .use(requireAuth)
        .get('/whoami', ({ user: u, session, authenticationMethod }) => ({
          userId: u?.id ?? null,
          sessionId: session?.id ?? null,
          authenticationMethod,
        }))
    );

    const response = await app.handle(new Request('http://localhost/whoami'));

    // The guard let the request through *and* the handler saw the same derived
    // values. A derive that runs after `onBeforeHandle` would 401 here; one that
    // runs but does not propagate would answer 200 with nulls.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: user.id,
      sessionId: 'lifecycle-session',
      authenticationMethod: 'session',
    });
  });

  it('reports api-key authentication when the key header is present', async () => {
    const user = await insertTestUser();
    const spy = spyOnGetSession(sessionFor(user.id));
    cleanup = spy.restore;

    const app = createApiTestApp(
      new Elysia().use(requireAuth).get('/whoami', ({ authenticationMethod }) => ({
        authenticationMethod,
      }))
    );

    const response = await app.handle(
      new Request('http://localhost/whoami', { headers: { [API_KEY_HEADER]: 'mango_probe' } })
    );

    expect(await response.json()).toEqual({ authenticationMethod: 'api-key' });
  });

  it('resolves the session once per request however many modules mount the guard', async () => {
    const user = await insertTestUser();
    const spy = spyOnGetSession(sessionFor(user.id));
    cleanup = spy.restore;

    // Three sibling modules, each mounting `requireAuth` the way every real
    // route module does. Without plugin deduplication the async derive
    // re-registers per module and the session lookup runs three times on one
    // request — three database round trips for every API call.
    const moduleA = new Elysia().use(requireAuth).get('/a', () => ({ ok: 'a' }));
    const moduleB = new Elysia().use(requireAuth).get('/b', () => ({ ok: 'b' }));
    const moduleC = new Elysia().use(requireAuth).get('/c', () => ({ ok: 'c' }));
    const app = createApiTestApp(moduleA, moduleB, moduleC);

    const response = await app.handle(new Request('http://localhost/a'));

    expect(response.status).toBe(200);
    expect(spy.calls).toBe(1);
  });
});

describe('scoped guards cover their own subtree only', () => {
  it('keeps an adjacent module public while its sibling is protected', async () => {
    const spy = spyOnGetSession(null);
    cleanup = spy.restore;

    // The production shape: sibling route modules mounted onto one parent, only
    // some of which opt into `requireAuth`. `.as('scoped')` is what stops the
    // guard from escaping its own instance — a widened scope silently 401s the
    // public modules, and a narrowed one silently opens the protected ones.
    const protectedModule = new Elysia().use(requireAuth).get('/protected', () => ({ ok: true }));
    const publicModule = new Elysia().get('/public', () => ({ ok: true }));
    const app = createApiTestApp(protectedModule, publicModule).get('/parent-public', () => ({
      ok: true,
    }));

    expect((await app.handle(new Request('http://localhost/protected'))).status).toBe(401);
    expect((await app.handle(new Request('http://localhost/public'))).status).toBe(200);
    expect((await app.handle(new Request('http://localhost/parent-public'))).status).toBe(200);
  });

  it('protects every route inside the module that mounted the guard', async () => {
    const spy = spyOnGetSession(null);
    cleanup = spy.restore;

    const app = createApiTestApp(
      new Elysia()
        .use(requireAuth)
        .get('/first', () => ({ ok: true }))
        .group('/nested', (group) => group.get('/second', () => ({ ok: true })))
    );

    expect((await app.handle(new Request('http://localhost/first'))).status).toBe(401);
    expect((await app.handle(new Request('http://localhost/nested/second'))).status).toBe(401);
  });
});

describe('guard responses reach the client intact', () => {
  it('keeps the status and body a rejecting guard set', async () => {
    const spy = spyOnGetSession(null);
    cleanup = spy.restore;

    const app = createApiTestApp(
      new Elysia()
        .use(errorHandler)
        .use(requireAuth)
        .get('/protected', () => ({ ok: true }))
    );

    const response = await app.handle(new Request('http://localhost/protected'));

    // `set.status` is assigned inside `onBeforeHandle` and the body is returned
    // from the same hook. Both halves have to survive: a status that reverts to
    // 200 turns a refusal into an apparent success carrying an error body.
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      code: ERROR_CODES.UNAUTHORIZED,
    });
  });

  it('keeps headers a hook set before the handler ran', async () => {
    const limiter = rateLimit({ classify: classifyRateLimit, trustProxy: true });
    const app = createApiTestApp(limiter).get('/probe', () => ({ ok: true }));

    const response = await app.handle(new Request('http://localhost/probe', { headers: CALLER }));

    // The limiter writes `X-RateLimit-*` into `set.headers` from its
    // `onBeforeHandle` and then lets the request through. Those mutations are
    // dropped whenever a hook is compiled in a way that discards `set`.
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ratelimit-limit')).toBeTruthy();
    expect(response.headers.get('x-ratelimit-remaining')).toBeTruthy();
    expect(response.headers.get('x-ratelimit-reset')).toBeTruthy();

    limiter.teardown();
  });
});

describe('rate-limit classification is ready before enforcement', () => {
  it('publishes clientIp from derive to every later hook and handler', async () => {
    const limiter = rateLimit({ classify: classifyRateLimit, trustProxy: true });
    // Read through a cast: the limiter is a plain function plugin, so its
    // `derive` is invisible to the app's static context type. That is exactly
    // why the value needs a runtime assertion rather than a compile-time one.
    const app = createApiTestApp(limiter).get('/probe', (context) => ({
      clientIp: (context as { clientIp?: string }).clientIp,
    }));

    const response = await app.handle(new Request('http://localhost/probe', { headers: CALLER }));

    // The limiter's own `onBeforeHandle` early-returns when `clientIp` is
    // missing or 'unknown'. A derive that stops landing before it therefore
    // disables rate limiting outright — no error, no 500, just an API with no
    // limiter. Asserting the derived value is visible downstream is the cheap
    // way to see that happen.
    expect(await response.json()).toEqual({ clientIp: '203.0.113.9' });

    limiter.teardown();
  });

  it('enforces the classified bucket rather than the default one', async () => {
    // `classifyRateLimit` must run with a path the limiter also enforces on: a
    // classification that lands too late (or against the wrong path) would put
    // health traffic in the general bucket.
    const limiter = rateLimit({ classify: classifyRateLimit, trustProxy: true });
    const api = new Elysia({ prefix: '/api' })
      .use(errorHandler)
      .use(limiter)
      .get('/health', () => ({ status: 'ok' }))
      .get('/chats', () => ({ ok: true }));
    const app = createApiTestApp(api);
    const get = (path: string) =>
      app.handle(new Request(`http://localhost${path}`, { headers: CALLER }));

    // Driven off the bucket rather than a literal: this asserts which bucket
    // enforces, not what its ceiling happens to be, and a hardcoded 100 turned
    // a retune of that ceiling into a failure here (#941).
    for (let i = 0; i <= RATE_LIMIT_BUCKETS.general.max; i += 1) await get('/api/chats');

    expect((await get('/api/chats')).status).toBe(429);
    expect((await get('/api/health')).status).toBe(200);

    limiter.teardown();
  });
});

describe('apiKeyGuard leaves the request body alone', () => {
  it('lets a downstream handler read the body it did not consume', async () => {
    // The Better Auth passthrough hands the raw `request` to a downstream
    // reader. A guard that touches the whole context makes Elysia eagerly parse
    // the body, and the passthrough then fails with ERR_BODY_ALREADY_USED —
    // which is why the guard casts a narrow context slice instead of
    // destructuring `request` in its parameter list.
    const app = createApiTestApp(
      apiKeyGuard,
      new Elysia().post('/echo', async ({ request }) => ({ echo: await request.json() }))
    );

    const response = await app.handle(
      new Request('http://localhost/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: 'mango_unverified' },
        body: JSON.stringify({ hello: 'world' }),
      })
    );

    // The key is unverifiable, so the guard refuses — but it must refuse
    // without having drained the stream, which is what the 401 (rather than a
    // 500 from a re-read) proves.
    expect(response.status).toBe(401);

    const passthrough = await app.handle(
      new Request('http://localhost/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      })
    );

    expect(passthrough.status).toBe(200);
    expect(await passthrough.json()).toEqual({ echo: { hello: 'world' } });
  });

  it('returns immediately for a request with no key header', async () => {
    // The early return is what keeps cookie-session traffic off the Better Auth
    // key-verification path entirely. `getApiKeyApi` is not stubbed here: a
    // guard that stopped short-circuiting would reach it and fail differently.
    const app = createApiTestApp(
      apiKeyGuard,
      new Elysia().get('/open', () => ({ ok: true }))
    );

    const response = await app.handle(new Request('http://localhost/open'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
