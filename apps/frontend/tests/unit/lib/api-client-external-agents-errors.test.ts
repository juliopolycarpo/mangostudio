/**
 * Eden error channels for the external-agents routes.
 *
 * These handlers used to assign `set.status = 4xx` and return a bare body. On a
 * route with no declared `response` map Eden types that body into the successful
 * `data` channel, because the status lives in a mutable bag the types never see
 * (the review route, whose success is an SSE `Response`). They now return
 * `status(code, body)`, so the code travels in the return type and the body lands
 * in `error`. Routes with a declared map already typed correctly; their
 * assertions keep the declarations from drifting from the statuses the handlers
 * can return. The routes below cover the shapes in the module: a plain error
 * body, a computed code (`apiErrorStatus`) and a refusal that is not an
 * `ApiErrorResponse` at all (approval and steer answers). Compile-time
 * assertions with a token runtime body; `tsc` runs them under `bun run check`.
 */

import { describe, expect, it } from 'bun:test';

import type { ApiErrorResponse } from '@mangostudio/shared/errors';

import { client } from '../../../src/lib/api-client';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertType<_T extends true>(): void {
  // Compile-time only: the type parameter constraint does the work.
}

/**
 * The body of the error variant at `Code`. `never` when the result has no error
 * at that status, which is what makes a missing declaration fail an assertion.
 * Scoped by status because a route with a `query` or `body` also carries a 422
 * validation problem that is not an `ApiErrorResponse`.
 */
type ErrorBodyAt<Result extends { error: unknown }, Code extends number> =
  Extract<NonNullable<Result['error']>, { status: Code }> extends { value: infer Value }
    ? Value
    : never;

/** True when the error at `Code` exists and every body it can carry is a `Shape`. */
type ErrorAtIs<Result extends { error: unknown }, Code extends number, Shape> = [
  ErrorBodyAt<Result, Code>,
] extends [never]
  ? false
  : [ErrorBodyAt<Result, Code>] extends [Shape]
    ? true
    : false;

/** True when at least one body the error at `Code` can carry is a `Shape`. */
type ErrorCarries<Result extends { error: unknown }, Code extends number, Shape> = [
  Extract<ErrorBodyAt<Result, Code>, Shape>,
] extends [never]
  ? false
  : true;

/** True when no member of the success channel has the shape of `Refusal`. */
type DataLacks<Result extends { data: unknown }, Refusal> = [
  Extract<NonNullable<Result['data']>, Refusal>,
] extends [never]
  ? true
  : false;

/** The steer and approval bodies the API answers with at a non-2xx status. */
interface SteerRefusal {
  readonly accepted: false;
  readonly reasonCode: string;
}

/** True when the error at `Code` can carry a `status: 'rejected'` approval answer. */
type RejectedAnswerAt<Result extends { error: unknown }, Code extends number> =
  ErrorBodyAt<Result, Code> extends { status: infer Answer }
    ? 'rejected' extends Answer
      ? true
      : false
    : false;

const externalAgents = client.api['external-agents'];
type SessionsResult = Awaited<ReturnType<(typeof externalAgents)['sessions']['get']>>;
type DisclosureAckResult = Awaited<
  ReturnType<ReturnType<typeof externalAgents>['disclosure']['post']>
>;
type SteerResult = Awaited<
  ReturnType<ReturnType<typeof client.api.chats>['external-agent']['steer']['post']>
>;
type RespondResult = Awaited<
  ReturnType<ReturnType<typeof client.api.chats>['external-agent']['respond']['post']>
>;

type ReviewResult = Awaited<
  ReturnType<ReturnType<typeof client.api.chats>['external-agent']['review']['post']>
>;

// 0. Review: no response map, so the handler's return type is all Eden has. A
//    preflight refusal (computed code, `apiErrorStatus`) and the unknown-chat
//    404 must be errors, never part of `data`.
assertType<Equals<DataLacks<ReviewResult, { error: string }>, true>>();
assertType<Equals<ErrorAtIs<ReviewResult, 400, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<ReviewResult, 403, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<ReviewResult, 404, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<ReviewResult, 409, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<ReviewResult, 503, ApiErrorResponse>, true>>();

// 1. Session listing: a refusal's status is computed (`apiErrorStatus`), and
//    each literal it can take is declared in the route's response map.
assertType<Equals<DataLacks<SessionsResult, { error: string }>, true>>();
assertType<Equals<ErrorAtIs<SessionsResult, 400, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<SessionsResult, 401, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<SessionsResult, 403, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<SessionsResult, 404, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<SessionsResult, 409, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<SessionsResult, 503, ApiErrorResponse>, true>>();

// 2. Disclosure acknowledgement: plain literal statuses.
assertType<Equals<DataLacks<DisclosureAckResult, { error: string }>, true>>();
assertType<Equals<ErrorAtIs<DisclosureAckResult, 401, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<DisclosureAckResult, 404, ApiErrorResponse>, true>>();
assertType<Equals<ErrorAtIs<DisclosureAckResult, 503, ApiErrorResponse>, true>>();

// 3. Steer: a rejection answers 409 with the steer result itself, not an
//    `ApiErrorResponse`, and must land in `error`.
//    The declared 409 schema is the whole steer union, so `ErrorCarries` (some
//    arm matches) is the strongest claim the declaration supports.
assertType<Equals<ErrorCarries<SteerResult, 409, SteerRefusal>, true>>();
assertType<Equals<ErrorAtIs<SteerResult, 401, ApiErrorResponse>, true>>();

// 4. Approval answers: a rejected answer at 400 | 404 | 409 is an error.
assertType<Equals<RejectedAnswerAt<RespondResult, 400>, true>>();
assertType<Equals<RejectedAnswerAt<RespondResult, 404>, true>>();
assertType<Equals<RejectedAnswerAt<RespondResult, 409>, true>>();

describe('Eden error channels for external-agents routes', () => {
  it('keeps refusals out of the success channel', () => {
    // The assertions above are enforced by `bun run check`.
    expect(typeof externalAgents.sessions.get).toBe('function');
    expect(typeof externalAgents({ targetId: 'codex' }).disclosure.post).toBe('function');
    expect(typeof client.api.chats({ id: 'chat-1' })['external-agent'].steer.post).toBe('function');
  });
});
