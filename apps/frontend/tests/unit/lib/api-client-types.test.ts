/**
 * The Eden seam: what `treaty<App>` still knows about the API.
 *
 * This is the only place the frontend's types come from the backend's routes.
 * It is also the quietest thing in the repository to break — when Eden loses
 * hold of `App`, every route collapses to `any` and the application keeps
 * compiling. Wrong field names, wrong body shapes, and removed endpoints all
 * become runtime bugs, and no other test notices, because `any` satisfies
 * every assertion anyone would write against it.
 *
 * So these are compile-time assertions with a token runtime body. `tsc` is the
 * thing actually running them, under `bun run check`; the `expect` at the end
 * only keeps the file honest as a test.
 */

import { describe, expect, it } from 'bun:test';

import type { ContextCompactionResponse } from '@mangostudio/shared/chat';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';

import { client } from '../../../src/lib/api-client';

/**
 * `true` only when `A` and `B` are mutually assignable. Declared here rather
 * than imported: `@mangostudio/shared/test-utils` does not re-export shared's
 * copy, and this is the only frontend file that needs it.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails the typecheck unless the supplied condition is exactly `true`. */
function assertType<_T extends true>(): void {
  // Compile-time only: the type parameter constraint does the work.
}

/** True only for `any` — `0 extends 1 & T` holds for nothing else. */
type IsAny<T> = 0 extends 1 & T ? true : false;

type HealthResponse = Awaited<ReturnType<typeof client.api.health.get>>;
type ChatsPostBody = Parameters<typeof client.api.chats.post>[0];
type ChatsPostResponse = Awaited<ReturnType<typeof client.api.chats.post>>;
type ChatsGetResponse = Awaited<ReturnType<typeof client.api.chats.get>>;

// 1. The `/api` namespace still exists as a namespace. `treaty<App>` only
//    produces it when it can read the prefixed sub-instance out of `App`; a
//    client that lost the type would make this `any`.
assertType<Equals<IsAny<typeof client.api>, false>>();
assertType<Equals<IsAny<HealthResponse>, false>>();

// 2. Shared error hooks carry explicit status codes. Elysia beta.21 propagates
//    inherited hook responses into route types, so a plain error object with
//    only `set.status` would incorrectly enter Eden's successful `data` here.
assertType<Equals<HealthResponse['data'], { status: string; timestamp: number } | null>>();

// 3. The transport-level error channel stays typed rather than becoming `any`.
//    Exact on purpose: a channel that collapsed to `null` leaves `never` once
//    `null` is stripped, and `never` satisfies any looser `extends` check.
assertType<
  Equals<
    HealthResponse['error'],
    | { status: 429; value: ApiErrorResponse }
    | { status: 500; value: ApiErrorResponse }
    | { status: 503; value: ApiErrorResponse }
    | null
  >
>();

// 4. A schema-backed POST keeps its request body exactly as the TypeBox schema
//    declares it: `title` required, `model` and `operationId` optional. This is the direction
//    that matters most — an `any` body accepts every typo silently.
assertType<Equals<ChatsPostBody, { title: string; model?: string; operationId?: string }>>();

// 5. And its response keeps the full entity, including the discriminated
//    `runner` union and the template-literal agent id. That id survives a
//    `Type.Unsafe` in the shared schema, so it is the single best proof that
//    precise types cross the whole chain — schema, route, Eden, component.
type ChatData = NonNullable<ChatsPostResponse['data']>;
assertType<Equals<IsAny<ChatData>, false>>();
assertType<
  Equals<
    Extract<ChatData['runner'], { kind: 'mangostudio' }>['agentId'],
    'default' | 'explore' | `user:${string}`
  >
>();

// 6. A list route stays an array of the same entity rather than `unknown[]`.
assertType<Equals<ChatsGetResponse['data'], ChatData[] | null>>();

// 7. The socket-adjacent route is still reachable through the same client, so
//    a WebSocket route dropping out of `App` fails here rather than at runtime.
assertType<Equals<IsAny<typeof client.api.ws.subscribe>, false>>();
assertType<
  Equals<typeof client.api.ws.subscribe extends (...args: never) => unknown ? true : false, true>
>();

// 8. The GitHub routes keep the typed error channel their `response` maps
//    declare. Two things once erased it: an `as const` on the shared error map
//    (Eden then read `error` as `unknown`), and the callers' `{}` workaround
//    that followed. Each route is pinned on two facts, because a widened
//    channel breaks both: the exact set of statuses the route can answer, and
//    the body shape of every status the route itself declares. The statuses
//    outside that declaration (401, 403, 422, 429) come from the shared auth,
//    API-key, validation and rate-limit hooks every route inherits.
type InheritedHookStatus = 401 | 403 | 422 | 429;
type ChatScopedStatus = InheritedHookStatus | 404 | 409 | 500 | 503;
type InboxStatus = InheritedHookStatus | 500 | 503;

/**
 * Constrained to Eden's `{ status, value }` arms (or `null`) so a channel that
 * widened to `unknown` or `{}` fails to satisfy the check instead of indexing.
 */
type TreatyResponse = { error: { status: number; value: unknown } | null };
type ErrorArms<Response extends TreatyResponse> = Exclude<Response['error'], null>;
type ErrorStatuses<Response extends TreatyResponse> = ErrorArms<Response>['status'];
type ErrorBodyAt<Response extends TreatyResponse, Status extends number> = Extract<
  ErrorArms<Response>,
  { status: Status }
>['value'];

/**
 * Mutual assignability. The 500 arm is a union of the route's declared body and
 * the error hook's, structurally identical but distinct type identities, so the
 * identity-based `Equals` reports them unequal.
 */
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Chat-scoped routes declare 404, 409, 500 and 503 beyond what the hooks add. */
type ChatScopedErrorsExact<Response extends TreatyResponse> =
  Equals<ErrorStatuses<Response>, ChatScopedStatus> extends true
    ? SameShape<ErrorBodyAt<Response, 404 | 409 | 500 | 503>, ApiErrorResponse>
    : false;

/** The inbox has no chat to refuse, so it declares only 500 and 503. */
type InboxErrorsExact<Response extends TreatyResponse> =
  Equals<ErrorStatuses<Response>, InboxStatus> extends true
    ? SameShape<ErrorBodyAt<Response, 500 | 503>, ApiErrorResponse>
    : false;

type GithubContextResponse = Awaited<ReturnType<typeof client.api.github.context.get>>;
type GithubInboxResponse = Awaited<ReturnType<typeof client.api.github.inbox.get>>;
type GithubPrsResponse = Awaited<ReturnType<typeof client.api.github.prs.get>>;
type GithubIssuesResponse = Awaited<ReturnType<typeof client.api.github.issues.get>>;
type GithubPrDetailResponse = Awaited<ReturnType<typeof client.api.github.pr.get>>;
type GithubPrChecksResponse = Awaited<ReturnType<typeof client.api.github.pr.checks.get>>;
type GithubPrThreadsResponse = Awaited<
  ReturnType<(typeof client.api.github.pr)['review-threads']['get']>
>;
type GithubCreatePrResponse = Awaited<ReturnType<typeof client.api.github.pr.post>>;
type GithubPrReadyResponse = Awaited<ReturnType<typeof client.api.github.pr.ready.post>>;
type GithubPrCheckoutResponse = Awaited<ReturnType<typeof client.api.github.pr.checkout.post>>;

assertType<ChatScopedErrorsExact<GithubContextResponse>>();
assertType<InboxErrorsExact<GithubInboxResponse>>();
assertType<ChatScopedErrorsExact<GithubPrsResponse>>();
assertType<ChatScopedErrorsExact<GithubIssuesResponse>>();
assertType<ChatScopedErrorsExact<GithubPrDetailResponse>>();
assertType<ChatScopedErrorsExact<GithubPrChecksResponse>>();
assertType<ChatScopedErrorsExact<GithubPrThreadsResponse>>();
assertType<ChatScopedErrorsExact<GithubCreatePrResponse>>();
assertType<ChatScopedErrorsExact<GithubPrReadyResponse>>();
assertType<ChatScopedErrorsExact<GithubPrCheckoutResponse>>();

// 9. Routes with no declared `response` map take their error channel from what
//    the handler returns. A handler that assigns `set.status` and returns a bare
//    `ApiErrorResponse` types that body into Eden's successful `data`, so a
//    caller reading `data` sees an error body as a success. Handlers return
//    `status(code, body)` instead, which lands the body in `error`. These three
//    routes answer through the shared failure helpers (skills, agents, rule
//    files) and have no `response` map of their own.
type SkillsListResponse = Awaited<ReturnType<typeof client.api.skills.get>>;
type AgentGetResponse = Awaited<ReturnType<ReturnType<typeof client.api.settings.agents>['get']>>;
type RuleFilePreviewResponse = Awaited<
  ReturnType<(typeof client.api.settings)['rule-files']['preview']['post']>
>;

/** True when an error body can be read from the successful `data` channel. */
type ErrorBodyInData<Response extends { data: unknown }> = [ApiErrorResponse] extends [
  NonNullable<Response['data']>,
]
  ? true
  : false;

/** True when every error arm at `Status` carries an `ApiErrorResponse`-shaped body. */
type ErrorBodyIsApiError<Response extends TreatyResponse, Status extends number> = [
  ErrorBodyAt<Response, Status>,
] extends [ApiErrorResponse]
  ? true
  : false;

assertType<Equals<ErrorBodyInData<SkillsListResponse>, false>>();
assertType<Equals<ErrorBodyInData<AgentGetResponse>, false>>();
assertType<Equals<ErrorBodyInData<RuleFilePreviewResponse>, false>>();

// Connectors answer every failure through `handleConnectorError` and declare no
// `response` map either, so a failed add must not read as a connector.
type ConnectorAddResponse = Awaited<ReturnType<typeof client.api.settings.connectors.post>>;
assertType<Equals<ErrorBodyInData<ConnectorAddResponse>, false>>();
assertType<ErrorBodyIsApiError<ConnectorAddResponse, 403 | 404 | 409 | 410 | 500 | 502>>();
assertType<Equals<Extract<ErrorStatuses<ConnectorAddResponse>, 502 | 503>, 502 | 503>>();

// The statuses each handler can answer with, beside what the shared hooks add.
assertType<Equals<ErrorStatuses<SkillsListResponse>, InheritedHookStatus | 404 | 500 | 503>>();
assertType<Equals<ErrorStatuses<AgentGetResponse>, 401 | 404 | 409 | 422 | 500 | 503>>();
assertType<Equals<ErrorStatuses<RuleFilePreviewResponse>, 401 | 404 | 422 | 500>>();
assertType<ErrorBodyIsApiError<SkillsListResponse, 403 | 404 | 422 | 500 | 503>>();
assertType<ErrorBodyIsApiError<AgentGetResponse, 404 | 409 | 500 | 503>>();
// Its 422 is Elysia's own body validation, a `ValidationProblem`, so only the
// handler's statuses are checked here.
assertType<ErrorBodyIsApiError<RuleFilePreviewResponse, 404 | 500>>();

// 10. Chat and message handlers once assigned `set.status` and returned a bare
//     `ApiErrorResponse`. Eden typed that body into the successful `data`, so the
//     callers cast `data` back to the contract type. They return
//     `status(code, body)` now and declare each status in the route's `response`
//     map: error bodies land in `error`, and `data` is the contract type as is.
type ChatCompactResponse = Awaited<
  ReturnType<ReturnType<typeof client.api.chats>['compact']['post']>
>;
type ChatUpdateResponse = Awaited<ReturnType<ReturnType<typeof client.api.chats>['put']>>;
type MessageUpdateResponse = Awaited<ReturnType<ReturnType<typeof client.api.messages>['put']>>;

assertType<Equals<ErrorBodyInData<ChatCompactResponse>, false>>();
assertType<Equals<ErrorBodyInData<ChatUpdateResponse>, false>>();
assertType<Equals<ErrorBodyInData<MessageUpdateResponse>, false>>();

// `data` carries the success contract only, so callers need no cast.
assertType<SameShape<NonNullable<ChatCompactResponse['data']>, ContextCompactionResponse>>();
assertType<SameShape<NonNullable<ChatUpdateResponse['data']>, { success: true }>>();
assertType<SameShape<NonNullable<MessageUpdateResponse['data']>, { success: true }>>();

// Each route answers its own failures with an `ApiErrorResponse` body, beside
// the 401 and 422 (Elysia's body validation) the hooks add and the 500 of the
// error handler. The chat update's 422 is also its own validation refusal.
assertType<Equals<ErrorStatuses<ChatCompactResponse>, 401 | 422 | 400 | 404 | 409 | 500 | 503>>();
assertType<Equals<ErrorStatuses<ChatUpdateResponse>, 401 | 422 | 400 | 404 | 500>>();
assertType<Equals<ErrorStatuses<MessageUpdateResponse>, 401 | 422 | 404 | 409 | 500>>();
assertType<ErrorBodyIsApiError<ChatCompactResponse, 400 | 404 | 409 | 503>>();
assertType<ErrorBodyIsApiError<ChatUpdateResponse, 400 | 404 | 422>>();
assertType<ErrorBodyIsApiError<MessageUpdateResponse, 404 | 409>>();

describe('Eden treaty type seam', () => {
  it('keeps route input and output types inferable from App', () => {
    // The assertions above are enforced by `bun check`. Reaching this body
    // at all means the client module loaded and every one of them compiled.
    expect(typeof client.api.chats.post).toBe('function');
    expect(typeof client.api.health.get).toBe('function');
    expect(typeof client.api.ws.subscribe).toBe('function');
  });
});
