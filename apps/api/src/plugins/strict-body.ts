/**
 * Keeps a request body with an unknown field an error on a closed schema.
 *
 * Elysia 2.0.0-rc.4 answered a body that a closed object schema
 * (`additionalProperties: false`) rejected with 422. From rc.5 the default
 * `normalize` setting instead strips what the closed schema rejects and carries
 * on, so a misspelled field stopped being an error and became a value silently
 * ignored. This API's contract is the rc.4 one, and this plugin restores it for
 * request bodies and only for them:
 *
 * - `normalize: false` is the only switch Elysia offers, and it is global (a
 *   plugin's own setting is ignored; the root app's wins). It also closes every
 *   open schema, rejects unknown query keys, and answers a response carrying a
 *   key its schema does not list with a 500, so it cannot be scoped to bodies.
 * - Open schemas keep stripping, exactly as in rc.4: the plugin only acts on a
 *   body that Elysia would otherwise repair by stripping.
 * - Query, header and response schemas keep Elysia's rc.5 behaviour.
 *
 * It throws Elysia's own `ValidationError` before validation runs, so
 * `errorHandler` answers with the usual `ApiErrorResponse`.
 *
 * How it sees the body is shaped by one Elysia trait: Elysia reads a hook's
 * source (aliases included) to decide what to prepare, and a global hook that
 * names `body` makes it parse the body of EVERY route. That drains the stream
 * before a route that reads `request` itself (the Better Auth passthrough) can.
 * So no hook here names `body`. An `onRequest` hook reads a private copy of the
 * body, for a JSON request to a route that may be governed, and `onTransform`
 * (which knows the exact route) judges it. Elysia parses the original untouched.
 * `lifecycle-contract.integration.test.ts` and this plugin's unit test pin it.
 *
 * Mount it once, ahead of the routes it governs: a hook only reaches routes
 * declared after it. `app.ts` mounts it on the `/api` instance and the route
 * test harness mounts it on its root, so a route test sees what production does.
 *
 * @example
 * const api = new Elysia({ prefix: '/api' }).use(errorHandler).use(strictBodies);
 */

import { type AnyElysia, ValidationError } from 'elysia';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/schema';
import Value from 'typebox/value';

/** A compiled check over one body schema; the shape `typebox/schema` returns. */
interface BodyCheck {
  Check(value: unknown): boolean;
}

/** What the guard keeps per body schema, built on the first request that needs it. */
interface StrictBodyEntry {
  schema: TSchema;
  check: BodyCheck;
}

/** Whether any object node under `schema` is closed with `additionalProperties: false`. */
export function declaresClosedObject(schema: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return false;
  seen.add(schema);
  if ((schema as { additionalProperties?: unknown }).additionalProperties === false) return true;
  for (const child of Object.values(schema)) {
    if (declaresClosedObject(child, seen)) return true;
  }
  return false;
}

/** JSON-shaped input only: a stream, a `Form` or a primitive is not this guard's to judge. */
function isJsonContainer(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether `raw` fails `schema` only because of keys a closed object does not
 * declare: it is invalid as received and valid once those keys are cleaned off.
 *
 * Elysia applies defaults before it checks, so they are applied here first (on
 * a clone: `Default` and `Clean` work in place). A body that is invalid for any
 * other reason returns false, so Elysia reports that failure as it always did.
 */
export function failsOnlyOnUnknownKeys(entry: StrictBodyEntry, raw: unknown): boolean {
  if (entry.check.Check(raw)) return false;

  const defaulted = Value.Default(entry.schema, structuredClone(raw));
  if (entry.check.Check(defaulted)) return false;

  return entry.check.Check(Value.Clean(entry.schema, defaulted));
}

/** Builds the per-schema entry, or `null` when the schema has no closed object to guard. */
export function createStrictBodyEntry(schema: unknown): StrictBodyEntry | null {
  if (typeof schema !== 'object' || schema === null || !('~kind' in schema)) return null;
  if (!declaresClosedObject(schema)) return null;
  return { schema: schema as TSchema, check: Compile(schema as TSchema) };
}

/** The route key both sides agree on: method plus the path pattern, without a trailing slash. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path}`;
}

/**
 * A pattern that matches every path the route pattern can serve, and possibly
 * more: `:param` stands for one segment, `*` for the rest. It only narrows which
 * requests get their body copied; the exact route is decided later.
 */
export function routePathMatcher(pattern: string): RegExp {
  const segments = pattern
    .replace(/\/$/, '')
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '[^/]+';
      if (segment === '*') return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
  return new RegExp(`^${segments.join('/')}/?$`);
}

/** `application/json`, with or without parameters, and `+json` suffixed types. */
function isJsonContentType(contentType: string | null | undefined): boolean {
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType ?? '');
}

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface RouteLike {
  method: string;
  path: string;
  hooks?: { body?: unknown };
}

type RouteSource = { readonly routes: readonly RouteLike[] };

/**
 * What `onRequest` and `onTransform` read. `route` is the matched pattern and is
 * set for dynamic routes only; a static route is identified by `path`. There is
 * deliberately no `body` here: see the module comment.
 */
interface HookContext {
  request: Request;
  route?: string;
  path?: string;
}

/** The slice of an `Elysia` instance this plugin uses, typed loosely so any app generic fits. */
interface HookHost {
  onRequest(hook: (context: unknown) => void): unknown;
  onTransform(hook: (context: unknown) => Promise<void>): unknown;
}

/** A copy of a request's JSON body: the value, or `undefined` when it is not parseable JSON. */
type CopiedBody = Promise<unknown>;

/** What the guard derives from the route table, once, on the first request. */
interface StrictBodyTable {
  entries: Map<string, StrictBodyEntry>;
  /** Per method, the paths of the routes that have an entry. */
  matchers: Map<string, RegExp[]>;
}

function buildTable(app: unknown): StrictBodyTable {
  const entries = new Map<string, StrictBodyEntry>();
  const matchers = new Map<string, RegExp[]>();
  for (const route of (app as RouteSource).routes) {
    if (route.hooks?.body === undefined) continue;
    let entry: StrictBodyEntry | null;
    try {
      entry = createStrictBodyEntry(route.hooks.body);
    } catch (error) {
      // A schema TypeBox cannot compile is Elysia's to report, with its own
      // message; failing open here keeps this guard from adding a second one.
      console.warn(
        `[strict-body] ${route.method} ${route.path}: guard skipped, schema did not compile (${String(error)})`
      );
      continue;
    }
    if (!entry) continue;
    entries.set(routeKey(route.method, route.path), entry);
    const forMethod = matchers.get(route.method) ?? [];
    forMethod.push(routePathMatcher(route.path));
    matchers.set(route.method, forMethod);
  }
  return { entries, matchers };
}

/**
 * Registers the guard on `app` and returns it, for `.use(strictBodies)`.
 *
 * It is a function plugin, not a named `Elysia` instance, because it has to
 * read the root's route table to learn which schema governs the matched route:
 * the hook context carries the matched pattern (`route`, set for dynamic
 * routes) or the path (static routes) but not the schema itself.
 */
export function strictBodies<App extends AnyElysia>(app: App): App {
  // Keyed by the request object, which `onRequest` and `onTransform` share.
  const copies = new WeakMap<Request, CopiedBody>();

  // `app.routes` rebuilds its list on every read in production, so the table is
  // built once, on the first body request, when every route is registered.
  let table: StrictBodyTable | undefined;
  const tableOf = () => (table ??= buildTable(app));

  (app as unknown as HookHost).onRequest((context) => {
    const hook = context as HookContext;
    const request = hook.request;
    if (!METHODS_WITH_BODY.has(request.method)) return;
    if (!isJsonContentType(request.headers.get('content-type'))) return;

    const matchers = tableOf().matchers.get(request.method);
    if (!matchers) return;
    const pathname = hook.path ?? new URL(request.url).pathname;
    if (!matchers.some((matcher) => matcher.test(pathname))) return;

    // Unparseable JSON is Elysia's to report when it parses the original.
    copies.set(
      request,
      request
        .clone()
        .json()
        .catch(() => undefined)
    );
  });

  (app as unknown as HookHost).onTransform(async (context) => {
    const hook = context as HookContext;
    const copy = copies.get(hook.request);
    if (!copy) return;

    const entry = tableOf().entries.get(
      routeKey(hook.request.method, hook.route ?? hook.path ?? '')
    );
    if (!entry) return;

    const raw = await copy;
    if (!isJsonContainer(raw) || !failsOnlyOnUnknownKeys(entry, raw)) return;
    throw new ValidationError('body', raw, () => Value.Errors(entry.schema, raw), entry.schema);
  });

  return app;
}
