/**
 * `closedBodies` keeps Elysia rc.4's answer for a body with an unknown field: a
 * closed schema rejects it with 422, an open schema still strips it.
 *
 * Every case drives a real `Elysia` app with the real error handler, because
 * the behaviour under test is the interplay with Elysia's own validator, which
 * strips under rc.5, and with its body parsers. Nothing here is faked.
 */

import { describe, expect, it } from 'bun:test';

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import Value from 'typebox/value';

import { declaresClosedObject } from '../../../src/lib/reject-unknown-body-fields';
import { closedBodies } from '../../../src/plugins/closed-bodies';
import { errorHandler } from '../../../src/plugins/error-handler';

const CLOSED = { additionalProperties: false } as const;
const UNKNOWN = 'unknownFieldFromUnitTest';

const ClosedRootBody = t.Object({ name: t.String() }, CLOSED);
const OpenRootBody = t.Object({ name: t.String() });
const NestedClosedInOpenRoot = t.Object({ inner: t.Object({ name: t.String() }, CLOSED) });
/** An integer a client may send as the string "5": Elysia coerces it before the check. */
const CoercedClosedBody = t.Object({ name: t.String(), days: t.Optional(t.Integer()) }, CLOSED);
/** Same shape as the tool-identity update: an optional closed object inside a union with null. */
const ClosedObjectInUnion = t.Object(
  {
    image: t.Optional(
      t.Union([
        t.Object({ source: t.Literal('url'), url: t.String(), cache: t.Boolean() }, CLOSED),
        t.Null(),
      ])
    ),
  },
  CLOSED
);

/** Registered before `closedBodies`, to show the mount position is load-bearing. */
const routesBeforeMount = new Elysia().post(
  '/before-mount',
  { body: ClosedRootBody },
  ({ body }) => ({ body })
);

/** A plugin with its own prefix, as the route modules are. */
const prefixedRoutes = new Elysia({ prefix: '/module' })
  .post('/closed', { body: ClosedRootBody }, ({ body }) => ({ body }))
  .post('/closed/:id/item', { body: ClosedRootBody }, ({ body, params }) => ({
    body,
    id: params.id,
  }))
  .post('/open', { body: OpenRootBody }, ({ body }) => ({ body }))
  .post('/nested-in-open', { body: NestedClosedInOpenRoot }, ({ body }) => ({ body }))
  .post('/union', { body: ClosedObjectInUnion }, ({ body }) => ({ body }))
  .post('/coerced', { body: CoercedClosedBody }, ({ body }) => ({ body }));

function buildApp() {
  return new Elysia()
    .use(routesBeforeMount)
    .use(errorHandler)
    .use(closedBodies)
    .use(prefixedRoutes)
    .group('/group', (group) =>
      group.post('/closed', { body: ClosedRootBody }, ({ body }) => ({ body }))
    );
}

type TestApp = ReturnType<typeof buildApp>;

function send(
  app: TestApp,
  path: string,
  body: string,
  contentType: string | null
): Promise<Response> {
  return Promise.resolve(
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: contentType === null ? {} : { 'content-type': contentType },
        body,
      })
    )
  );
}

function postJson(app: TestApp, path: string, body: unknown): Promise<Response> {
  return send(app, path, JSON.stringify(body), 'application/json');
}

async function expectInvalidRequestBody(response: Response, label: string): Promise<void> {
  expect(response.status, `${label}: expected 422 for an unknown field`).toBe(422);
  const payload = await response.json();
  expect(
    Value.Check(ApiErrorResponseSchema, payload),
    `${label}: expected an ApiErrorResponse, received ${JSON.stringify(payload)}`
  ).toBe(true);
  expect((payload as { code: string }).code).toBe(ERROR_CODES.VALIDATION);
}

describe('closedBodies', () => {
  it('rejects an unknown field on a closed root body with 422', async () => {
    const app = buildApp();

    await expectInvalidRequestBody(
      await postJson(app, '/module/closed', { name: 'a', [UNKNOWN]: 1 }),
      'closed root'
    );
  });

  it('accepts a valid body and hands the handler exactly that body', async () => {
    const app = buildApp();

    const response = await postJson(app, '/module/closed', { name: 'a' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { name: 'a' } });
  });

  it('covers a route under a dynamic segment and one registered through a group', async () => {
    const app = buildApp();

    await expectInvalidRequestBody(
      await postJson(app, '/module/closed/7/item', { name: 'a', [UNKNOWN]: 1 }),
      'dynamic route'
    );
    await expectInvalidRequestBody(
      await postJson(app, '/group/closed', { name: 'a', [UNKNOWN]: 1 }),
      'grouped route'
    );
  });

  it('rejects an unknown field in a nested closed object, under a closed or an open root', async () => {
    const app = buildApp();

    await expectInvalidRequestBody(
      await postJson(app, '/module/nested-in-open', { inner: { name: 'a', [UNKNOWN]: 1 } }),
      'nested closed object under an open root'
    );
    await expectInvalidRequestBody(
      await postJson(app, '/module/union', {
        image: { source: 'url', url: 'https://example.test/i.png', cache: false, [UNKNOWN]: 1 },
      }),
      'closed object in an optional union'
    );
  });

  it('accepts the union arms that are valid', async () => {
    const app = buildApp();

    expect((await postJson(app, '/module/union', { image: null })).status).toBe(200);
    expect((await postJson(app, '/module/union', {})).status).toBe(200);
  });

  it('keeps an open schema stripping, as in rc.4', async () => {
    const app = buildApp();

    const response = await postJson(app, '/module/open', { name: 'a', [UNKNOWN]: 1 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { name: 'a' } });
  });

  describe('every content type Elysia parses into an object', () => {
    it('rejects the unknown field in a form-urlencoded body', async () => {
      const app = buildApp();

      await expectInvalidRequestBody(
        await send(
          app,
          '/module/closed',
          `name=a&${UNKNOWN}=1`,
          'application/x-www-form-urlencoded'
        ),
        'urlencoded'
      );
    });

    it('accepts a valid form-urlencoded body', async () => {
      const app = buildApp();

      const response = await send(
        app,
        '/module/closed',
        'name=a',
        'application/x-www-form-urlencoded'
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: { name: 'a' } });
    });

    it('rejects the unknown field in a multipart body', async () => {
      const app = buildApp();
      const form = new FormData();
      form.set('name', 'a');
      form.set(UNKNOWN, '1');

      await expectInvalidRequestBody(
        await app.handle(
          new Request('http://localhost/module/closed', { method: 'POST', body: form })
        ),
        'multipart'
      );
    });

    it('rejects the unknown field in a +json body', async () => {
      const app = buildApp();

      await expectInvalidRequestBody(
        await send(
          app,
          '/module/closed',
          JSON.stringify({ name: 'a', [UNKNOWN]: 1 }),
          'text/x+json'
        ),
        '+json'
      );
    });

    it('rejects the unknown field when the JSON content type carries a charset', async () => {
      const app = buildApp();

      await expectInvalidRequestBody(
        await send(
          app,
          '/module/closed',
          JSON.stringify({ name: 'a', [UNKNOWN]: 1 }),
          'application/json; charset=utf-8'
        ),
        'json with charset'
      );
    });
  });

  describe('a body Elysia coerces before it checks', () => {
    it('rejects the unknown field next to a string that coerces to an integer', async () => {
      const app = buildApp();

      await expectInvalidRequestBody(
        await postJson(app, '/module/coerced', { name: 'a', days: '5', [UNKNOWN]: 1 }),
        'coerced body'
      );
    });

    it('accepts the same coerced body without the unknown field', async () => {
      const app = buildApp();

      const response = await postJson(app, '/module/coerced', { name: 'a', days: '5' });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: { name: 'a', days: 5 } });
    });
  });

  it('leaves the shared schema closed, since responses and OpenAPI still use it', async () => {
    const app = buildApp();
    await postJson(app, '/module/closed', { name: 'a' });

    expect(declaresClosedObject(ClosedRootBody)).toBe(true);
    expect(declaresClosedObject(ClosedObjectInUnion)).toBe(true);
  });

  it('leaves no closed object in the body schema of a route registered after it', () => {
    const app = buildApp();
    const mounted = (app as unknown as { routes: { path: string; hooks?: { body?: unknown } }[] })
      .routes;

    const stillClosed = mounted
      .filter((route) => route.path.startsWith('/module') || route.path.startsWith('/group'))
      .filter((route) => declaresClosedObject(route.hooks?.body))
      .map((route) => route.path);

    expect(stillClosed, 'routes whose body kept additionalProperties: false').toEqual([]);
  });

  it('does not reach a route registered before it is mounted', async () => {
    const app = buildApp();

    // Pinned so a reader knows why the mount sits first in `app.ts`: Elysia
    // strips here, so the unknown field is dropped and the request succeeds.
    const response = await postJson(app, '/before-mount', { name: 'a', [UNKNOWN]: 1 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { name: 'a' } });
  });
});
