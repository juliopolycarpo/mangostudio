import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { rateLimit } from '../../../src/plugins/rate-limit';

function createTestApp(trustProxy?: boolean) {
  const limiter = rateLimit({ max: 2, windowMs: 60_000, trustProxy });
  const app = new Elysia()
    .use(limiter)
    .get('/test', (ctx: Record<string, unknown>) => ({ ip: ctx.clientIp as string }));
  return { app, teardown: limiter.teardown };
}

describe('rate-limit trustProxy', () => {
  it('ignores X-Forwarded-For when trustProxy is false (default)', async () => {
    const { app, teardown } = createTestApp();

    // With trustProxy disabled, different X-Forwarded-For headers should be ignored.
    // The derived clientIp should NOT come from the header.
    const res1 = await app.handle(
      new Request('http://localhost/test', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      })
    );
    const body1 = (await res1.json()) as { ip: string };

    const res2 = await app.handle(
      new Request('http://localhost/test', {
        headers: { 'x-forwarded-for': '5.6.7.8' },
      })
    );
    const body2 = (await res2.json()) as { ip: string };

    // Both requests should resolve to the same IP (not the forwarded header value)
    expect(body1.ip).not.toBe('1.2.3.4');
    expect(body2.ip).not.toBe('5.6.7.8');
    expect(body1.ip).toBe(body2.ip);

    teardown();
  });

  it('honors X-Forwarded-For when trustProxy is true', async () => {
    const { app, teardown } = createTestApp(true);

    const res1 = await app.handle(
      new Request('http://localhost/test', {
        headers: { 'x-forwarded-for': '10.0.0.1' },
      })
    );
    const body1 = (await res1.json()) as { ip: string };

    const res2 = await app.handle(
      new Request('http://localhost/test', {
        headers: { 'x-forwarded-for': '10.0.0.2' },
      })
    );
    const body2 = (await res2.json()) as { ip: string };

    // Each request should have the forwarded IP
    expect(body1.ip).toBe('10.0.0.1');
    expect(body2.ip).toBe('10.0.0.2');

    teardown();
  });

  it('rate-limits by forwarded IP when trustProxy is true', async () => {
    const { app, teardown } = createTestApp(true);

    // Send 3 requests from the same forwarded IP — 3rd should be rate-limited
    for (let i = 0; i < 2; i++) {
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': '99.99.99.99' },
        })
      );
      expect(res.status).toBe(200);
    }

    const res = await app.handle(
      new Request('http://localhost/test', {
        headers: { 'x-forwarded-for': '99.99.99.99' },
      })
    );
    expect(res.status).toBe(429);

    // A different forwarded IP should NOT be rate-limited
    const resOther = await app.handle(
      new Request('http://localhost/test', {
        headers: { 'x-forwarded-for': '11.11.11.11' },
      })
    );
    expect(resOther.status).toBe(200);

    teardown();
  });
});
