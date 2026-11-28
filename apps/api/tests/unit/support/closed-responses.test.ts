/**
 * `createApiTestApp` makes an undeclared response key a failure, as on rc.4,
 * where production now strips it. These cases pin that the harness catches the
 * drift and leaves open response schemas alone.
 */

import { describe, expect, it } from 'bun:test';

import { Elysia, t } from 'elysia';

import { createApiTestApp } from '../../support/harness/create-api-test-app';

const CLOSED = { additionalProperties: false } as const;

const DriftedRoutes = new Elysia()
  .get('/closed-single', { response: t.Object({ id: t.String() }, CLOSED) }, () => ({
    id: 'a',
    leaked: 'secret',
  }))
  .get(
    '/closed-by-status',
    {
      response: { 200: t.Object({ id: t.String() }, CLOSED), 404: t.Object({ error: t.String() }) },
    },
    () => ({ id: 'a', leaked: 'secret' })
  )
  .get('/closed-clean', { response: t.Object({ id: t.String() }, CLOSED) }, () => ({ id: 'a' }))
  .get('/open', { response: t.Object({ id: t.String() }) }, () => ({ id: 'a', extra: 'kept' }));

describe('createApiTestApp closed responses', () => {
  it('fails a response with a key its closed schema does not declare', async () => {
    const app = createApiTestApp(DriftedRoutes);

    const response = await app.handle(new Request('http://localhost/closed-single'));

    expect(
      response.status,
      'expected 500 for an undeclared response key | received the response served'
    ).toBe(500);
  });

  it('applies to a response declared per status code', async () => {
    const app = createApiTestApp(DriftedRoutes);

    const response = await app.handle(new Request('http://localhost/closed-by-status'));

    expect(response.status).toBe(500);
  });

  it('serves a response that matches its closed schema', async () => {
    const app = createApiTestApp(DriftedRoutes);

    const response = await app.handle(new Request('http://localhost/closed-clean'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'a' });
  });

  it('leaves an open response schema as it was', async () => {
    const app = createApiTestApp(DriftedRoutes);

    const response = await app.handle(new Request('http://localhost/open'));

    expect(response.status).toBe(200);
  });
});
