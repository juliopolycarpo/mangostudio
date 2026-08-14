/**
 * The spec route's two departures from the rest of the API.
 *
 * First, the document does not describe the second error media type.
 * `@elysia/openapi` builds each response from the route's TypeBox schema, and a
 * route schema can describe exactly one body per status. The negotiated
 * representation is therefore invisible to it — not because the plugin is
 * wrong, but because two media types for one status is not something a response
 * schema can say. Rather than weaken response validation to express it, the
 * generated document is amended once, here, from the same contract the runtime
 * negotiator uses.
 *
 * Second, the spec route is the one route `errorHandler` never sees, so its own
 * failures are classified and negotiated here too. Both concerns are hooks that
 * have to precede `openapi()` in `app.ts`, which is why they share a module and
 * a plugin instance: the ordering constraint is stated once and cannot be half
 * satisfied.
 */

import {
  API_ERROR_RESPONSE_MEMBERS,
  type ApiErrorResponse,
  ERROR_CODES,
  PROBLEM_JSON_MEDIA_TYPE,
  ProblemDetailsSchema,
} from '@mangostudio/shared/errors';
import { type Context, Elysia, StatusMap } from 'elysia';
import { negotiateErrorRepresentation } from '../plugins/error-negotiation';

/** Where the OpenAPI UI and its document are mounted. */
export const OPENAPI_PATH = '/scalar';

/** The generated document itself, which is what gets amended. */
export const OPENAPI_SPEC_PATH = `${OPENAPI_PATH}/json`;

const PROBLEM_DETAILS_SCHEMA_NAME = 'ProblemDetails';
const PROBLEM_DETAILS_REF = `#/components/schemas/${PROBLEM_DETAILS_SCHEMA_NAME}`;

const NEGOTIATION_NOTE = [
  'Error responses are content-negotiated. By default every failure returns the',
  '`ApiErrorResponse` shape as `application/json`. A client that sends',
  '`Accept: application/problem+json` receives the same failure as an RFC 9457',
  'problem document instead, with an identical HTTP status and `code`. Responses',
  'that participate carry `Vary: Accept`.',
  '',
  'Only bodies that are exactly an `ApiErrorResponse` are re-rendered. A few',
  'endpoints answer a 4xx with an error plus domain data (for example an install',
  'refusal carrying its `recipe`); those keep their documented shape under either',
  '`Accept`, because a problem document has nowhere to put the extra members.',
].join('\n');

interface MediaTypeObject {
  schema?: unknown;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

interface OperationObject {
  responses?: Record<string, ResponseObject>;
}

interface OpenApiDocument {
  info?: { description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, unknown> };
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

/**
 * Does this documented schema describe a body the runtime would re-render?
 *
 * Mirrors `asApiErrorResponse` in the error negotiator, one level up: the
 * property set must be a subset of `API_ERROR_RESPONSE_MEMBERS` and must
 * include `error`. Anything else — an install refusal, a domain payload — is
 * left documented as `application/json` only, which is the truth.
 *
 * `anyOf`/`oneOf` is recursed because a couple of statuses are declared as a
 * union of a plain error and a richer body. One negotiable branch is enough for
 * the status to be able to answer with problem details.
 */
function describesNegotiableError(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const candidate = schema as Record<string, unknown>;

  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = candidate[key];
    if (Array.isArray(branches)) return branches.some(describesNegotiableError);
  }

  if (candidate.type !== 'object') return false;

  const properties = candidate.properties;
  if (!properties || typeof properties !== 'object') return false;

  const names = Object.keys(properties);
  if (!names.includes('error')) return false;
  return names.every((name) => API_ERROR_RESPONSE_MEMBERS.has(name));
}

/**
 * Add an `application/problem+json` entry beside every negotiable error body.
 *
 * Pure and idempotent: it clones its input, and re-running it over its own
 * output is a no-op. That is what lets it sit on a response hook without
 * caring whether the plugin cached the document it was handed.
 */
export function withProblemDetailsMedia<T>(document: T): T {
  if (!document || typeof document !== 'object') return document;

  const amended = structuredClone(document) as OpenApiDocument;

  amended.components ??= {};
  amended.components.schemas ??= {};
  amended.components.schemas[PROBLEM_DETAILS_SCHEMA_NAME] = {
    ...ProblemDetailsSchema,
    description:
      'RFC 9457 problem details. Returned in place of `ApiErrorResponse` when the ' +
      'request explicitly accepts `application/problem+json`. `status` always equals ' +
      'the HTTP status, and `code` carries the same value the legacy body would.',
  };

  // Appended only once. The plugin may hand out a cached document, so this runs
  // over its own output whenever the spec is fetched more than once.
  if (amended.info && !amended.info.description?.includes(NEGOTIATION_NOTE)) {
    amended.info.description = amended.info.description
      ? `${amended.info.description}\n\n${NEGOTIATION_NOTE}`
      : NEGOTIATION_NOTE;
  }

  for (const methods of Object.values(amended.paths ?? {})) {
    if (!methods || typeof methods !== 'object') continue;

    for (const [method, operation] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;

      for (const [status, response] of Object.entries(operation?.responses ?? {})) {
        if (Number.parseInt(status, 10) < 400) continue;

        const content = response?.content;
        if (!content || content[PROBLEM_JSON_MEDIA_TYPE]) continue;
        if (!describesNegotiableError(content['application/json']?.schema)) continue;

        content[PROBLEM_JSON_MEDIA_TYPE] = { schema: { $ref: PROBLEM_DETAILS_REF } };
      }
    }
  }

  return amended as T;
}

/**
 * Is this response a failure rather than the generated document?
 *
 * `set.status` is the only signal available before the body is inspected, and
 * it carries two spellings — a number from `set.status = 500` and a reason
 * phrase from `set.status = 'Internal Server Error'`. Reading only the first
 * would let a phrase-spelled failure through as a document.
 */
function isFailureStatus(status: Context['set']['status']): boolean {
  if (typeof status === 'number') return status >= 400;
  if (typeof status === 'string') {
    const mapped = StatusMap[status as keyof typeof StatusMap];
    return typeof mapped === 'number' && mapped >= 400;
  }
  return false;
}

/**
 * Spec-route hooks: amend the document, and sanitize a failed generation.
 *
 * Both must be registered on the app *before* `openapi()`, which is why they
 * live on one instance rather than two that could drift apart: Elysia applies a
 * global hook only to routes declared after it, so mounting this later would
 * leave the spec route — and only the spec route — unhooked.
 *
 * The error arm is the reason that constraint is load-bearing twice.
 * `@elysia/openapi` puts its own local `error` hook on the spec route that logs
 * and returns nothing; that hook consumes the failure before `errorHandler`'s
 * arms — which are mounted later still, inside the `/api` instance — ever see
 * it, so Elysia falls back to its built-in renderer and publishes the raw
 * exception message as `detail` on an unauthenticated endpoint. This arm is
 * seated early enough to answer first.
 */
export const openapiProblemDetails = new Elysia({ name: 'openapi-problem-details' })
  .mapResponse('global', ({ path, request, responseValue, set }) => {
    if (path !== OPENAPI_SPEC_PATH) return undefined;
    if (!responseValue || typeof responseValue !== 'object') return undefined;
    if (responseValue instanceof Response) return undefined;

    // Amend a document, never an error body. The arm below answers a failed
    // generation with a plain `ApiErrorResponse` from this same path, which is
    // also a plain object — without this gate it would be merged with
    // `components.schemas` and served as a hybrid of the two. Gating on the
    // status rather than on the error shape keeps this hook uncoupled from the
    // error contract: a body it does not recognise is still not a document.
    //
    // The failure is handed to the negotiator instead. `errorHandler`'s copy
    // cannot reach here — it is mounted inside `/api`, after `openapi` — and a
    // spec failure answering only `application/json` while every other failure
    // negotiates would be an inconsistency owed entirely to hook order.
    if (isFailureStatus(set.status)) {
      return negotiateErrorRepresentation(request, set, responseValue);
    }

    return new Response(JSON.stringify(withProblemDetailsMedia(responseValue)), {
      headers: { 'content-type': 'application/json;charset=utf-8' },
    });
  })
  .error('global', ({ error, set, path }): ApiErrorResponse | undefined => {
    // Scoped to the one route this module owns. Every other failure belongs to
    // `errorHandler`, which classifies validation and 404s rather than calling
    // everything a 500 — returning `undefined` here lets it do that.
    if (path !== OPENAPI_SPEC_PATH) return undefined;

    // Logged the way `error-handler.ts` logs its catch-all arm — server-side is
    // the only record of what actually failed, and the client is told nothing —
    // under this module's own tag rather than `[error-handler]`, so a failure
    // the error handler could not have produced is not filed under its name.
    console.error(`[openapi-spec][${error instanceof Error ? error.name : 'unknown'}]`, error);
    set.status = 500;
    return { error: 'An internal error occurred', code: ERROR_CODES.INTERNAL };
  });
