/**
 * Every route that declares a request body rejects an unknown field, over the real app.
 *
 * Elysia 2.0.0-rc.5 strips what a closed schema rejects instead of answering 422
 * (see `src/plugins/strict-body.ts`). The two route tests that noticed pinned
 * single routes; this walks the whole route table so the next route cannot
 * regress alone, and a route that gains or loses `additionalProperties: false`
 * is a failing test rather than a changed answer nobody sees.
 *
 * The contract is the rc.4 one, and it is the schema's, not a blanket rule:
 *
 * - a body schema that closes its object rejects an unknown field with 422, at
 *   the top level and in every nested closed object;
 * - a route whose root schema is open never rejected, it stripped. Those routes
 *   are listed in `OPEN_BODY_ROUTES` with the reason, so that moving one in or
 *   out of the list is a decision in a diff.
 *
 * A body is mutated only into what TypeBox itself rejects (`Value.Check`), so
 * each 422 is attributable to the unknown field and not to a baseline that was
 * invalid to begin with.
 */

import { describe, expect, it } from 'bun:test';

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';

import { app } from '../../../src/app';
import {
  createStrictBodyEntry,
  declaresClosedObject,
  failsOnlyOnUnknownKeys,
} from '../../../src/plugins/strict-body';
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

async function send(route: BodyRoute, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${concretePath(route)}`, {
      method: route.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function expectRejectedAsInvalidBody(route: BodyRoute, body: unknown, where: string) {
  const response = await send(route, body);
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

      it('is rejected for the unknown field alone, by the guard or by the schema itself', () => {
        const mutated = withUnknownFieldAt(baselineFor(route), []);
        const entry = createStrictBodyEntry(route.schema);
        if (entry) {
          // `additionalProperties: false`: Elysia would strip, so the guard must be what judges.
          expect(
            failsOnlyOnUnknownKeys(entry, mutated),
            `${route.key}: expected the guard to find only unknown keys wrong with ${JSON.stringify(mutated)}`
          ).toBe(true);
        } else {
          // `additionalProperties: Type.Never()` and kin: Elysia rejects these natively.
          expect(
            declaresClosedObject(route.schema),
            `${route.key}: expected a closed schema the guard skips to be one Elysia rejects natively`
          ).toBe(false);
          expect(Value.Check(route.schema, mutated)).toBe(false);
        }
      });
    });
  }

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
