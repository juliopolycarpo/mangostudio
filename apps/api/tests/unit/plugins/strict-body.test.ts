/**
 * `strictBodies` restores Elysia rc.4's answer for a body with an unknown field:
 * a closed schema rejects it with 422, an open schema still strips it.
 *
 * Every case drives a real `Elysia` app, because the behaviour under test is the
 * interplay with Elysia's own validator (which strips under rc.5) and with the
 * route table the guard reads. Nothing here is faked.
 */

import { describe, expect, it } from 'bun:test';

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import Value from 'typebox/value';

import { errorHandler } from '../../../src/plugins/error-handler';
import {
  createStrictBodyEntry,
  declaresClosedObject,
  failsOnlyOnUnknownKeys,
  routeKey,
  routePathMatcher,
  strictBodies,
} from '../../../src/plugins/strict-body';

const CLOSED = { additionalProperties: false } as const;

function failFixture(message: string): never {
  throw new Error(`strict-body test fixture invalid: ${message}`);
}

const ClosedRootBody = t.Object({ name: t.String() }, CLOSED);
const OpenRootBody = t.Object({ name: t.String() });
const NestedClosedInOpenRoot = t.Object({ inner: t.Object({ name: t.String() }, CLOSED) });
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
const DefaultedClosedBody = t.Object(
  { name: t.String(), mode: t.String({ default: 'fast' }) },
  CLOSED
);

function buildApp() {
  return (
    new Elysia()
      .use(errorHandler)
      .use(strictBodies)
      // A prefix and a group, as `app.ts` composes routes.
      .group('/api', (api) =>
        api
          .post('/closed', { body: ClosedRootBody }, ({ body }) => ({ body }))
          .post('/closed/:id/item', { body: ClosedRootBody }, ({ body, params }) => ({
            body,
            id: params.id,
          }))
          .post('/open', { body: OpenRootBody }, ({ body }) => ({ body }))
          .post('/nested-in-open', { body: NestedClosedInOpenRoot }, ({ body }) => ({ body }))
          .post('/union', { body: ClosedObjectInUnion }, ({ body }) => ({ body }))
          .post('/defaulted', { body: DefaultedClosedBody }, ({ body }) => ({ body }))
          .get(
            '/list',
            { query: t.Object({ page: t.Optional(t.String()) }, CLOSED) },
            ({ query }) => ({
              query,
            })
          )
      )
  );
}

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
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

describe('strictBodies', () => {
  it('rejects an unknown top-level field on a closed schema with the ApiErrorResponse 422', async () => {
    const response = await post(buildApp(), '/api/closed', { name: 'a', nmae: 'typo' });
    await expectInvalidRequestBody(response, 'POST /api/closed');
  });

  it('accepts a body that declares every field it sends', async () => {
    const response = await post(buildApp(), '/api/closed', { name: 'a' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { name: 'a' } });
  });

  it('finds the schema of a dynamic route through the matched pattern', async () => {
    const response = await post(buildApp(), '/api/closed/7/item', { name: 'a', extra: 1 });
    await expectInvalidRequestBody(response, 'POST /api/closed/:id/item');
  });

  it('treats a trailing slash on the request as the same route', async () => {
    // Elysia serves `/api/closed/` from the `/api/closed` route; the guard must find
    // the same schema for it.
    const response = await post(buildApp(), '/api/closed/', { name: 'a', extra: 1 });
    await expectInvalidRequestBody(response, 'POST /api/closed/');
  });

  it('rejects an unknown field inside a closed object nested in an open root', async () => {
    const response = await post(buildApp(), '/api/nested-in-open', {
      inner: { name: 'a', extra: true },
    });
    await expectInvalidRequestBody(response, 'POST /api/nested-in-open');
  });

  it('rejects an unknown field in a closed object reached through a union with null', async () => {
    const response = await post(buildApp(), '/api/union', {
      image: { source: 'url', url: 'https://example.test/a.png', cache: false, cacheKey: 'forged' },
    });
    await expectInvalidRequestBody(response, 'POST /api/union');
  });

  it('still accepts a valid union member and an explicit null', async () => {
    const app = buildApp();
    const valid = await post(app, '/api/union', {
      image: { source: 'url', url: 'https://example.test/a.png', cache: true },
    });
    const cleared = await post(app, '/api/union', { image: null });
    expect([valid.status, cleared.status]).toEqual([200, 200]);
  });

  it('keeps stripping unknown fields on an open schema, as rc.4 did', async () => {
    const response = await post(buildApp(), '/api/open', { name: 'a', extra: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { name: 'a' } });
  });

  it('leaves a body invalid for another reason to Elysia', async () => {
    const response = await post(buildApp(), '/api/closed', { extra: 1 });
    await expectInvalidRequestBody(response, 'POST /api/closed without the required field');
  });

  it('applies schema defaults before judging, so a defaulted closed body is accepted', async () => {
    const response = await post(buildApp(), '/api/defaulted', { name: 'a' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { name: 'a', mode: 'fast' } });
  });

  it('does not touch query schemas: a closed query strips an unknown key, which rc.4 rejected', async () => {
    // Pinned so a change in Elysia's query behaviour is noticed, not assumed.
    const response = await buildApp().handle(new Request('http://localhost/api/list?page=1&utm=x'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ query: { page: '1' } });
  });

  it('leaves the body of a route with no closed body schema unread, for a handler that reads it itself', async () => {
    // The Better Auth passthrough reads `request` itself. A hook that makes Elysia
    // parse every body first would drain the stream and fail this with a 500.
    const app = new Elysia()
      .use(strictBodies)
      .post('/passthrough', async ({ request }) => ({ echo: await request.json() }));
    const response = await app.handle(
      new Request('http://localhost/passthrough', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echo: { hello: 'world' } });
  });

  it('judges the exact route, so a static route shadowing a closed dynamic one is not governed by it', async () => {
    const app = new Elysia()
      .use(strictBodies)
      .post('/things/:id', { body: ClosedRootBody }, ({ body }) => ({ route: 'dynamic', body }))
      .post('/things/special', { body: OpenRootBody }, ({ body }) => ({ route: 'static', body }));

    const shadowed = await app.handle(
      new Request('http://localhost/things/special', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a', extra: 1 }),
      })
    );
    expect(shadowed.status).toBe(200);
    expect(await shadowed.json()).toEqual({ route: 'static', body: { name: 'a' } });

    const governed = await app.handle(
      new Request('http://localhost/things/7', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a', extra: 1 }),
      })
    );
    expect(governed.status).toBe(422);
  });

  it('leaves malformed JSON for Elysia to report, as before', async () => {
    const malformed = () =>
      new Request('http://localhost/api/closed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name": ',
      });
    // Same route without the guard: whatever Elysia answers for it, the guard must not change.
    const unguarded = new Elysia()
      .use(errorHandler)
      .post('/api/closed', { body: ClosedRootBody }, ({ body }) => ({ body }));

    const guarded = await buildApp().handle(malformed());
    const plain = await unguarded.handle(malformed());
    expect(
      guarded.status,
      `expected the guarded status to equal the unguarded ${plain.status} for malformed JSON`
    ).toBe(plain.status);
  });

  it('ignores a body that is not a JSON container', async () => {
    const app = new Elysia()
      .use(strictBodies)
      .post('/text', { body: t.String() }, ({ body }) => ({ body }));
    const response = await app.handle(
      new Request('http://localhost/text', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      })
    );
    expect(response.status).toBe(200);
  });
});

describe('declaresClosedObject', () => {
  it('finds a closed object at the root, nested, and inside a union', () => {
    expect(declaresClosedObject(ClosedRootBody)).toBe(true);
    expect(declaresClosedObject(NestedClosedInOpenRoot)).toBe(true);
    expect(declaresClosedObject(ClosedObjectInUnion)).toBe(true);
  });

  it('is false for a schema with only open objects', () => {
    expect(declaresClosedObject(OpenRootBody)).toBe(false);
    expect(declaresClosedObject(t.Array(OpenRootBody))).toBe(false);
  });

  it('terminates on a self-referencing value', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(declaresClosedObject(cycle)).toBe(false);
  });
});

describe('createStrictBodyEntry', () => {
  it('returns null for an open schema and for a non-TypeBox value', () => {
    expect(createStrictBodyEntry(OpenRootBody)).toBeNull();
    expect(createStrictBodyEntry({ '~standard': {} })).toBeNull();
    expect(createStrictBodyEntry('model-name')).toBeNull();
  });
});

describe('failsOnlyOnUnknownKeys', () => {
  const entry = createStrictBodyEntry(ClosedRootBody) ?? failFixture('ClosedRootBody has no entry');

  it('is true only when cleaning the unknown keys makes the body valid', () => {
    expect(failsOnlyOnUnknownKeys(entry, { name: 'a', extra: 1 })).toBe(true);
    expect(failsOnlyOnUnknownKeys(entry, { name: 'a' })).toBe(false);
    expect(failsOnlyOnUnknownKeys(entry, { name: 1, extra: 1 })).toBe(false);
    expect(failsOnlyOnUnknownKeys(entry, {})).toBe(false);
  });

  it('does not mutate the body it judges', () => {
    const raw = { name: 'a', extra: 1 };
    failsOnlyOnUnknownKeys(entry, raw);
    expect(raw).toEqual({ name: 'a', extra: 1 });
  });
});

describe('routePathMatcher', () => {
  it('matches a param as one segment, a wildcard as the rest, and tolerates a trailing slash', () => {
    const param = routePathMatcher('/api/chats/:id/compact');
    expect(param.test('/api/chats/abc/compact')).toBe(true);
    expect(param.test('/api/chats/abc/compact/')).toBe(true);
    expect(param.test('/api/chats/a/b/compact')).toBe(false);
    expect(param.test('/api/chats//compact')).toBe(false);

    const wildcard = routePathMatcher('/files/*');
    expect(wildcard.test('/files/a/b/c')).toBe(true);
    expect(wildcard.test('/other/a')).toBe(false);
  });

  it('treats regex characters in a static segment literally', () => {
    const matcher = routePathMatcher('/v1.0/items');
    expect(matcher.test('/v1.0/items')).toBe(true);
    expect(matcher.test('/v1x0/items')).toBe(false);
  });
});

describe('routeKey', () => {
  it('joins method and path, dropping a trailing slash except for the root', () => {
    expect(routeKey('POST', '/api/chats/')).toBe('POST /api/chats');
    expect(routeKey('POST', '/api/chats')).toBe('POST /api/chats');
    expect(routeKey('GET', '/')).toBe('GET /');
  });
});
