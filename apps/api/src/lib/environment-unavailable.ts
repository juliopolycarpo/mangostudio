/**
 * The one HTTP mapping for "the environment this request needs cannot be
 * reached right now".
 *
 * The connection manager rejects every connect failure with a `RemoteError`
 * carrying the `UNAVAILABLE` code, so a route that reaches an environment does
 * not need to know which transport failed or why: the message already says. A
 * request that fails this way is a recoverable server condition, not a bug, so
 * it answers 503 with the reason rather than a generic 500.
 *
 * Both the error handler plugin (for routes that let the error escape) and the
 * routes that catch their own errors call this, so the status and code cannot
 * drift apart.
 */

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';

/** Detail key the connection manager sets when it knows when the next attempt is allowed. */
export const RETRY_AFTER_SECONDS_DETAIL = 'retryAfterSeconds';

export function isEnvironmentUnavailable(error: unknown): error is RemoteError {
  return error instanceof RemoteError && error.code === RESERVED_ERROR_CODES.UNAVAILABLE;
}

interface ResponseSettings {
  status?: number | string;
  headers: Record<string, string | number | string[]>;
}

/**
 * Renders an unavailable-environment error as a 503 `ApiErrorResponse`, setting
 * the status and `Retry-After` when the manager supplied a wait. Returns `null`
 * for any other error so the caller keeps its own classification.
 *
 * @example
 * const body = environmentUnavailableResponse(error, set);
 * if (body) return body;
 */
export function environmentUnavailableResponse(
  error: unknown,
  set: { status?: number | string; headers?: ResponseSettings['headers'] }
): ApiErrorResponse | null {
  if (!isEnvironmentUnavailable(error)) return null;

  set.status = 503;
  const retryAfter = error.details?.[RETRY_AFTER_SECONDS_DETAIL];
  if (set.headers && typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    set.headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfter)));
  }
  return { error: error.message, code: ERROR_CODES.PROVIDER_ERROR };
}
