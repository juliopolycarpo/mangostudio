/**
 * Typed error answers for route handlers and their shared `*Failure` helpers.
 *
 * A handler that assigns `set.status` and returns a bare `ApiErrorResponse`
 * types that body into Eden's successful `data`, because the status lives in a
 * mutable bag the types never see. `status(code, body)` carries the code in the
 * return type, so the body lands in `error` instead. This module is the one
 * place that spells the pattern for helpers whose status is a union decided at
 * runtime (a domain error carrying `404 | 409`).
 */

import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { type ElysiaStatus, status } from 'elysia';

/**
 * One single-code `ElysiaStatus` per member of `Code`.
 *
 * Not `ElysiaStatus<404 | 409, ...>`: a union code is invariant in Elysia's
 * class, and routes with a declared `response` map reject it. Distributing
 * gives each status its own arm, which both kinds of route accept.
 */
export type ApiErrorStatus<Code extends number> = Code extends unknown
  ? ElysiaStatus<Code, ApiErrorResponse>
  : never;

/**
 * Answers `body` at `code`, typed as one arm per status in `code`'s union.
 *
 * @example
 * return apiErrorStatus(error.status, { error: error.message, code: error.code });
 */
export function apiErrorStatus<const Code extends number>(
  code: Code,
  body: ApiErrorResponse
): ApiErrorStatus<Code> {
  // The cast is sound: `status` builds the same runtime object whichever arm
  // of the union `code` selects, so the distributed type only widens the label.
  return status(code, body) as ApiErrorStatus<Code>;
}
