/**
 * Eden error channels for routes that share one declared error-response map.
 *
 * `api-keys` and `tool-identities` spread a module-level `errorResponses` map
 * into each route's `response`. Declaring that map `as const` makes Eden type
 * `error` as `unknown`, so callers had to route it through `throwApiError`.
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
