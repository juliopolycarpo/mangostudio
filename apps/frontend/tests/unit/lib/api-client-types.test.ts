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
    { status: 429; value: ApiErrorResponse } | { status: 500; value: ApiErrorResponse } | null
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
type ChatScopedStatus = InheritedHookStatus | 404 | 409 | 500;
type InboxStatus = InheritedHookStatus | 500;

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

/** Chat-scoped routes declare 404, 409 and 500 beyond what the hooks add. */
type ChatScopedErrorsExact<Response extends TreatyResponse> =
  Equals<ErrorStatuses<Response>, ChatScopedStatus> extends true
    ? SameShape<ErrorBodyAt<Response, 404 | 409 | 500>, ApiErrorResponse>
    : false;

/** The inbox has no chat to refuse, so it declares only 500. */
type InboxErrorsExact<Response extends TreatyResponse> =
  Equals<ErrorStatuses<Response>, InboxStatus> extends true
    ? SameShape<ErrorBodyAt<Response, 500>, ApiErrorResponse>
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

describe('Eden treaty type seam', () => {
  it('keeps route input and output types inferable from App', () => {
    // The assertions above are enforced by `bun check`. Reaching this body
    // at all means the client module loaded and every one of them compiled.
    expect(typeof client.api.chats.post).toBe('function');
    expect(typeof client.api.health.get).toBe('function');
    expect(typeof client.api.ws.subscribe).toBe('function');
  });
});
