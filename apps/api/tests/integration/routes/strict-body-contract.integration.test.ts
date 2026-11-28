/**
 * Every route that declares a request body rejects an unknown field, over the real app.
 *
 * Elysia 2.0.0-rc.5 strips what a closed schema rejects instead of answering 422
 * (see `src/plugins/closed-bodies.ts`). The two route tests that noticed pinned
 * single routes; this walks the whole route table so the next route cannot
 * regress alone, and a route that gains or loses `additionalProperties: false`
 * is a failing test rather than a changed answer nobody sees.
 *
 * The contract is the rc.4 one, and it is the schema's, not a blanket rule:
 *
 * - a body schema that closes its object rejects an unknown field with 422, at
 *   the top level and in every nested closed object, whatever content type
 *   carries it (JSON, a `+json` type, urlencoded, multipart);
 * - a route whose root schema is open never rejected, it stripped. Those routes
 *   are listed in `OPEN_BODY_ROUTES` with the reason, so that moving one in or
 *   out of the list is a decision in a diff;
 * - no registered route still holds `additionalProperties: false` in its body,
 *   which is how a route registered ahead of the `closedBodies` mount shows up.
 *
 * A body is mutated only into what TypeBox itself rejects (`Value.Check`), so
 * each 422 is attributable to the unknown field and not to a baseline that was
 * invalid to begin with. For the form content types the same holds by
 * comparison: the unmutated body must get past validation in that encoding
 * before the mutated one is expected to be refused there.
 */

import { describe, expect, it } from 'bun:test';

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';

import { app } from '../../../src/app';
import { declaresClosedObject } from '../../../src/lib/reject-unknown-body-fields';
import {
  BASELINE_BODIES,
  FORM_BODY_ROUTES,
  OPEN_BODY_ROUTES,
} from '../../support/fixtures/strict-body-routes';

const UNKNOWN_FIELD = 'unknownFieldFromContractTest';

interface BodyRoute {
  key: string;
  method: string;
  path: string;
  schema: TSchema;
  params: TSchema | undefined;
}

function bodyRoutes(): BodyRoute[] {
  const routes = (
    app as unknown as {
      routes: { method: string; path: string; hooks?: { body?: unknown; params?: unknown } }[];
    }
  ).routes;
  return routes.flatMap((route) => {
    const body = route.hooks?.body;
    if (route.method === 'WS' || typeof body !== 'object' || body === null) return [];
    return [
      {
        key: `${route.method} ${route.path}`,
        method: route.method,
        path: route.path,
        schema: body as TSchema,
        params: route.hooks?.params as TSchema | undefined,
      },
    ];
  });
}

/** A concrete URL for a route pattern, using the params schema's own valid values where it has one. */
function concretePath(route: BodyRoute): string {
  let sample: Record<string, unknown> = {};
  try {
    sample = route.params ? (Value.Create(route.params) as Record<string, unknown>) : {};
  } catch {
    // A constrained params schema TypeBox cannot create; the placeholder below stands in.
  }
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    // `Value.Create` yields '' for an unconstrained string, which would drop the segment.
    const created = sample[name];
    return encodeURIComponent(typeof created === 'string' && created ? created : 'sample');
  });
}

const baselines = new Map<string, unknown>();

/**
 * A body valid for the route's schema: a fixture when one exists, else the
 * schema's own minimal value. TypeBox cannot create a pattern- or format-
 * constrained string, so such a route needs a fixture; `undefined` marks that.
 */
function baselineFor(route: BodyRoute): unknown {
  if (!baselines.has(route.key)) {
    let baseline: unknown = BASELINE_BODIES[route.key];
    if (baseline === undefined) {
      try {
        baseline = Value.Create(route.schema);
      } catch {
        baseline = undefined;
      }
    }
    baselines.set(route.key, baseline);
  }
  return baselines.get(route.key);
}

/**
 * Like `Value.Create`, but fills optional properties and one array item too, so
 * nested objects exist to probe. A part TypeBox cannot create is left out when it
 * is optional; the caller falls back to the minimal baseline if the result is
 * invalid for the schema.
 */
function createFull(schema: TSchema, depth = 0): unknown {
  const node = schema as unknown as JsonSchemaNode;
  if (depth > 6) return Value.Create(schema);
  if (Array.isArray(node.anyOf)) {
    for (const branch of node.anyOf) {
      try {
        return createFull(branch as unknown as TSchema, depth + 1);
      } catch {
        // try the next branch
      }
    }
    return Value.Create(schema);
  }
  if (node.type === 'object' && node.properties) {
    const required = new Set<string>(node.required ?? []);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node.properties)) {
      try {
        out[key] = createFull(child as unknown as TSchema, depth + 1);
      } catch (error) {
        if (required.has(key)) throw error;
      }
    }
    return out;
  }
  if (node.type === 'array' && node.items && !node.maxItems) {
    return [createFull(node.items as unknown as TSchema, depth + 1)];
  }
  return Value.Create(schema);
}

/** The slice of a JSON Schema node `createFull` reads. */
interface JsonSchemaNode {
  type?: string;
  anyOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  maxItems?: number;
}

/** The richest body valid for the route: the fixture, the full creation, else the minimal one. */
function probeBaselineFor(route: BodyRoute): unknown {
  if (BASELINE_BODIES[route.key] !== undefined) return BASELINE_BODIES[route.key];
  try {
    const full = createFull(route.schema);
    if (Value.Check(route.schema, full)) return full;
  } catch {
    // fall through to the minimal baseline
  }
  return baselineFor(route);
}

/** Every plain object inside `value`, as the path of keys and indexes that reaches it. */
function objectPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  if (typeof value !== 'object' || value === null) return [];
  return [
    path,
    ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key])),
  ];
}

function withUnknownFieldAt(baseline: unknown, path: (string | number)[]): unknown {
  const copy = structuredClone(baseline) as Record<string | number, unknown>;
  let target: Record<string | number, unknown> = copy;
  for (const step of path) target = target[step] as Record<string | number, unknown>;
  target[UNKNOWN_FIELD] = 'x';
  return copy;
}

/** The content types a body reaches Elysia in; each is parsed into an object by its own parser. */
type Encoding = 'json' | 'plusJson' | 'urlencoded' | 'multipart';

const FORM_ENCODINGS = ['urlencoded', 'multipart'] as const;

/** A form field carries text, so a structured value travels as its JSON text. */
function formFields(body: unknown): [string, string][] {
  return Object.entries(body as Record<string, unknown>).map(([name, value]) => [
    name,
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
  ]);
}

function requestInit(method: string, body: unknown, encoding: Encoding): RequestInit {
  switch (encoding) {
    case 'json':
      return {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    case 'plusJson':
      return { method, headers: { 'content-type': 'text/x+json' }, body: JSON.stringify(body) };
    case 'urlencoded':
      return {
        method,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formFields(body)).toString(),
      };
    case 'multipart': {
      // No content-type header: `fetch` adds the boundary with the FormData body.
      const form = new FormData();
      for (const [name, value] of formFields(body)) form.set(name, value);
      return { method, body: form };
    }
  }
}

async function send(route: BodyRoute, body: unknown, encoding: Encoding = 'json') {
  return app.handle(
    new Request(`http://localhost${concretePath(route)}`, requestInit(route.method, body, encoding))
  );
}

async function expectRejectedAsInvalidBody(
  route: BodyRoute,
  body: unknown,
  where: string,
  encoding: Encoding = 'json'
) {
  const response = await send(route, body, encoding);
  const text = await response.text();
  expect(
    response.status,
    `${route.key} (${where}): expected 422 for body ${JSON.stringify(body)} | received ${response.status} ${text.slice(0, 200)}`
  ).toBe(422);
  const payload = JSON.parse(text);
  expect(
    Value.Check(ApiErrorResponseSchema, payload),
    `${route.key} (${where}): expected an ApiErrorResponse | received ${text.slice(0, 200)}`
  ).toBe(true);
  expect(payload.code, `${route.key} (${where}): expected code ${ERROR_CODES.VALIDATION}`).toBe(
    ERROR_CODES.VALIDATION
  );
}

/** Whether a `t.File` sits anywhere in the schema: such a body is multipart, not JSON. */
function containsFile(schema: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return false;
  seen.add(schema);
  if ((schema as { '~kind'?: string })['~kind'] === 'File') return true;
  return Object.values(schema).some((child) => containsFile(child, seen));
}

const allBodyRoutes = bodyRoutes();
const routes = allBodyRoutes.filter((route) => !containsFile(route.schema));
const openKeys = new Set(Object.values(OPEN_BODY_ROUTES).flatMap((group) => group.routes));

/** What the form-encoded cases judged, for the coverage floor asserted after them. */
const formCoverage: Record<
  (typeof FORM_ENCODINGS)[number],
  { covered: string[]; skipped: string[] }
> = {
  urlencoded: { covered: [], skipped: [] },
  multipart: { covered: [], skipped: [] },
};

/**
 * Closed routes whose baseline survives being written as a form, measured when
 * the matrix was added (9 of 17). The rest carry arrays or nested required
 * values a flat form cannot express; they are judged as JSON and +json. A floor
 * so the matrix cannot quietly shrink to nothing, not a target.
 */
const MIN_FORM_COVERAGE = 9;

/** The routes whose root schema TypeBox rejects an unknown top-level field on. */
const closedRoutes = routes.filter((route) => {
  const baseline = baselineFor(route);
  return (
    Value.Check(route.schema, baseline) &&
    !Value.Check(route.schema, withUnknownFieldAt(baseline, []))
  );
});

describe('request bodies reject unknown fields (route table contract)', () => {
  it('finds the route table', () => {
    expect(
      routes.length,
      `expected the app to register body routes | received ${routes.length}`
    ).toBeGreaterThan(80);
  });

  it('leaves no route body, JSON or multipart, closed with additionalProperties: false', () => {
    // Elysia strips under that spelling, so a route that still has it is one the
    // `closedBodies` mount did not reach (registered before it, or on an app
    // built without it) and silently drops a misspelled field.
    const stillClosed = allBodyRoutes
      .filter((route) => declaresClosedObject(route.schema))
      .map((route) => route.key);
    expect(
      stillClosed,
      'expected every body schema rewritten by closedBodies | received additionalProperties: false in'
    ).toEqual([]);
  });

  it('treats exactly the multipart routes as form bodies', () => {
    const forms = allBodyRoutes
      .filter((route) => containsFile(route.schema))
      .map((route) => route.key)
      .sort();
    expect(forms, 'expected FORM_BODY_ROUTES to name every t.File body route and no other').toEqual(
      [...FORM_BODY_ROUTES].sort()
    );
  });

  it('has a valid baseline body for every route, so every 422 below is the unknown field', () => {
    const unusable = routes
      .filter((route) => !Value.Check(route.schema, baselineFor(route)))
      .map((route) => route.key);
    expect(
      unusable,
      `expected a baseline body valid for the schema (add one to BASELINE_BODIES) | received none for ${unusable.join(', ')}`
    ).toEqual([]);
  });

  it('lists as open exactly the routes whose root schema accepts an unknown top-level field', () => {
    const open = routes
      .filter((route) => !closedRoutes.includes(route))
      .map((route) => route.key)
      .sort();
    expect(
      open,
      'expected OPEN_BODY_ROUTES to name every open-root body route and no other'
    ).toEqual([...openKeys].sort());
  });

  it('gives every open-route group a reason', () => {
    for (const [name, group] of Object.entries(OPEN_BODY_ROUTES)) {
      expect(group.reason.length, `expected a reason for OPEN_BODY_ROUTES.${name}`).toBeGreaterThan(
        20
      );
    }
  });

  for (const route of closedRoutes) {
    describe(route.key, () => {
      it('answers an unknown top-level field with the ApiErrorResponse 422', async () => {
        await expectRejectedAsInvalidBody(
          route,
          withUnknownFieldAt(baselineFor(route), []),
          'top level'
        );
      });

      it('answers the unknown field in a +json body the same way', async () => {
        await expectRejectedAsInvalidBody(
          route,
          withUnknownFieldAt(baselineFor(route), []),
          'top level, text/x+json',
          'plusJson'
        );
      });

      for (const encoding of FORM_ENCODINGS) {
        it(`answers the unknown field in a ${encoding} body the same way`, async () => {
          const baseline = baselineFor(route);
          const accepted = await send(route, baseline, encoding);
          // A baseline this encoding cannot carry (a nested value the schema
          // wants as an object, a field the parser does not take) is refused
          // by validation or by the parser regardless of any unknown field, so
          // a 422 or 415 for it proves nothing and the route is left out.
          if (accepted.status === 422 || accepted.status === 415) {
            formCoverage[encoding].skipped.push(route.key);
            return;
          }
          formCoverage[encoding].covered.push(route.key);
          await expectRejectedAsInvalidBody(
            route,
            withUnknownFieldAt(baseline, []),
            `top level, ${encoding}`,
            encoding
          );
        });
      }
    });
  }

  it('reaches both form encodings on a meaningful share of the closed routes', () => {
    // Filled by the per-route cases above, which run first in file order. A
    // route is only skipped when its baseline cannot be written as a form; if
    // that became most routes the matrix would pass while proving nothing.
    for (const encoding of FORM_ENCODINGS) {
      const { covered, skipped } = formCoverage[encoding];
      expect(
        covered.length,
        `${encoding}: expected at least ${MIN_FORM_COVERAGE} closed routes judged | covered ${covered.length}, skipped ${skipped.join(', ')}`
      ).toBeGreaterThanOrEqual(MIN_FORM_COVERAGE);
    }
  });

  it('documents every closed request body as additionalProperties: false in the OpenAPI document', async () => {
    const response = await app.handle(new Request('http://localhost/scalar/json'));
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };

    const neverSpelled: string[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (
          JSON.stringify(operation.requestBody ?? {}).includes('"additionalProperties":{"not":{}}')
        )
          neverSpelled.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(
      neverSpelled,
      'expected request bodies documented with additionalProperties: false | received the Never spelling in'
    ).toEqual([]);

    const upgrade = JSON.stringify(document.paths['/api/machine/upgrade']?.post?.requestBody);
    expect(upgrade, 'expected POST /api/machine/upgrade to document a closed body').toContain(
      '"additionalProperties":false'
    );
  });

  it('rejects an unknown field next to a string Elysia coerces to the declared integer', async () => {
    // `expiresInDays` is an integer; "5" is coerced before the check. The
    // rc.4 answer for the unknown field was 422, and a check run on the raw body
    // instead of the coerced one would have let it through.
    const route = allBodyRoutes.find((candidate) => candidate.key === 'POST /api/api-keys/');
    expect(route, 'expected the route table to hold POST /api/api-keys/').toBeDefined();
    if (!route) return;
    const coerced = { ...(baselineFor(route) as object), expiresInDays: '5' };

    expect(
      (await send(route, coerced)).status,
      'the coerced body alone must pass validation'
    ).not.toBe(422);
    await expectRejectedAsInvalidBody(
      route,
      { ...coerced, [UNKNOWN_FIELD]: 1 },
      'coerced expiresInDays plus an unknown field'
    );
  });

  for (const route of routes) {
    const baseline = probeBaselineFor(route);
    if (!Value.Check(route.schema, baseline)) continue;
    const nested = objectPaths(baseline)
      .filter((path) => path.length > 0)
      .filter((path) => !Value.Check(route.schema, withUnknownFieldAt(baseline, path)));
    for (const path of nested) {
      it(`${route.key}: rejects an unknown field in nested object ${path.join('.')}`, async () => {
        await expectRejectedAsInvalidBody(
          route,
          withUnknownFieldAt(baseline, path),
          `nested ${path.join('.')}`
        );
      });
    }
  }
});
