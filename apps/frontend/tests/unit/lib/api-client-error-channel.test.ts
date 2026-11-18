/**
 * Eden error channels for routes that share one declared error-response map.
 *
 * `api-keys` and `tool-identities` spread a module-level `errorResponses` map
 * into each route's `response`. Declaring that map `as const` makes Eden type
 * `error` as `unknown`, so callers had to unwrap it without type checking.
 * These are compile-time assertions with a token runtime body; `tsc` runs them
 * under `bun run check`.
 */

import { describe, expect, it } from 'bun:test';

import type { ApiErrorResponse } from '@mangostudio/shared/errors';

import { client } from '../../../src/lib/api-client';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertType<_T extends true>(): void {
  // Compile-time only: the type parameter constraint does the work.
}

/** The `value` of every error variant on an Eden result, as one union. */
type ErrorValue<Result extends { error: unknown }> =
  NonNullable<Result['error']> extends { value: infer Value } ? Value : never;

/**
 * True when the error channel carries `ApiErrorResponse`-shaped bodies. It is
 * false for `unknown` (not assignable) and for a collapsed channel (`never`
 * would pass a bare `extends`, so it is excluded explicitly).
 */
type CarriesApiErrorBody<Result extends { error: unknown }> = [ErrorValue<Result>] extends [never]
  ? false
  : [ErrorValue<Result>] extends [ApiErrorResponse]
    ? true
    : false;

type ApiKeysListResult = Awaited<ReturnType<(typeof client.api)['api-keys']['get']>>;
type ToolIdentitiesListResult = Awaited<ReturnType<(typeof client.api)['tool-identities']['get']>>;

assertType<Equals<CarriesApiErrorBody<ApiKeysListResult>, true>>();
assertType<Equals<CarriesApiErrorBody<ToolIdentitiesListResult>, true>>();

describe('Eden error channels with a shared error-response map', () => {
  it('keeps api-keys and tool-identities errors typed as ApiErrorResponse', () => {
    // The assertions above are enforced by `bun run check`.
    expect(typeof client.api['api-keys'].get).toBe('function');
    expect(typeof client.api['tool-identities'].get).toBe('function');
  });
});

// Generation routes declare no `response` map, so Eden reads their error channel
// from what the handler returns. A handler that assigned `set.status` and returned
// a bare `ApiErrorResponse` typed that body into the successful `data` channel, so
// a caller reading `data` saw a refusal as a result. They answer `status(code, body)`
// now, which lands the body in `error`.
type RespondResult = Awaited<ReturnType<typeof client.api.respond.post>>;
type GenerateResult = Awaited<ReturnType<typeof client.api.generate.post>>;
type RespondStreamResult = Awaited<ReturnType<(typeof client.api.respond)['stream']['post']>>;

/** True when an error body can be read from the successful `data` channel. */
type ErrorBodyInData<Result extends { data: unknown }> = [ApiErrorResponse] extends [
  NonNullable<Result['data']>,
]
  ? true
  : false;

/** The statuses of every error arm on an Eden result. */
type ErrorStatuses<Result extends { error: unknown }> =
  NonNullable<Result['error']> extends { status: infer Status } ? Status : never;

/** The body of the error arms at `Status`. */
type ErrorBodyAt<Result extends { error: unknown }, Status extends number> =
  NonNullable<Result['error']> extends infer Arm
    ? Arm extends { status: Status; value: infer Value }
      ? Value
      : never
    : never;

assertType<Equals<ErrorBodyInData<RespondResult>, false>>();
assertType<Equals<ErrorBodyInData<GenerateResult>, false>>();

// The statuses the handlers answer, beside the 422 Elysia's body validation adds.
assertType<
  Equals<
    Extract<ErrorStatuses<RespondResult>, 400 | 404 | 409 | 410 | 500 | 503>,
    400 | 404 | 409 | 410 | 500 | 503
  >
>();
assertType<
  Equals<Extract<ErrorStatuses<GenerateResult>, 404 | 422 | 500 | 503>, 404 | 422 | 500 | 503>
>();
// Exact rather than assignable: a status that collapsed to `never` would pass a
// bare `extends`, and its 422 is Elysia's own `ValidationProblem`, so it is left out.
assertType<
  Equals<ErrorBodyAt<RespondResult, 400 | 404 | 409 | 410 | 500 | 503>, ApiErrorResponse>
>();
assertType<Equals<ErrorBodyAt<GenerateResult, 404 | 500 | 503>, ApiErrorResponse>>();
assertType<Equals<ErrorBodyInData<RespondStreamResult>, false>>();

describe('Eden error channels for generation routes', () => {
  it('lands respond and generate failures in `error`, not `data`', () => {
    // The assertions above are enforced by `bun run check`.
    expect(typeof client.api.respond.post).toBe('function');
    expect(typeof client.api.generate.post).toBe('function');
  });
});
