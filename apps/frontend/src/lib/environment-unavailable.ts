/**
 * How the client treats `ENVIRONMENT_UNAVAILABLE`: whether a failed query is
 * worth another attempt, how long to wait, and which failed queries to refetch
 * once an environment connects.
 *
 * The hub's connection manager owns the backoff and refuses attempts inside it,
 * so the client follows its word instead of guessing.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { Query, QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/utils';

/**
 * Reasons after which nothing changes by itself: the runtime is not installed,
 * is bound to another record, or the hub stopped retrying and waits for a user.
 * Mirrors the hub's `EnvironmentUnavailableReason` values of the same names.
 */
const PERMANENT_REASONS: ReadonlySet<string> = new Set([
  'stopped-retrying',
  'binary-missing',
  'bound-elsewhere',
]);

/** One retry for an ordinary failure and for a transient unavailable reason. */
const MAX_QUERY_RETRIES = 1;

/** TanStack Query's own default delay ceiling, kept for the fallback curve. */
const MAX_RETRY_DELAY_MS = 30_000;

function isEnvironmentUnavailableError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === ERROR_CODES.ENVIRONMENT_UNAVAILABLE;
}

/**
 * Whether a failed query should run again.
 *
 * A permanent reason is never retried. A transient one (`start-failed`,
 * `backing-off`, `unavailable`) gets the same single retry as any failure, but
 * delayed by {@link queryRetryDelay} until the hub allows another attempt.
 *
 * @example
 * shouldRetryQuery(0, new ApiError({ error: 'x', code: 'ENVIRONMENT_UNAVAILABLE', details: { reason: 'binary-missing' } })); // false
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isEnvironmentUnavailableError(error) && PERMANENT_REASONS.has(error.details?.reason ?? '')) {
    return false;
  }
  return failureCount < MAX_QUERY_RETRIES;
}

/**
 * Milliseconds to wait before the next attempt: the hub's `retryAfterSeconds`
 * when the error carries one, clamped to {@link MAX_RETRY_DELAY_MS}; otherwise
 * TanStack Query's default exponential delay.
 */
export function queryRetryDelay(failureCount: number, error: unknown): number {
  if (isEnvironmentUnavailableError(error) && error.retryAfterSeconds !== null) {
    return Math.min(MAX_RETRY_DELAY_MS, error.retryAfterSeconds * 1_000);
  }
  return Math.min(1_000 * 2 ** failureCount, MAX_RETRY_DELAY_MS);
}

/**
 * Refetches every query currently in error because its environment was
 * unavailable. Called when an environment is seen connected: those queries
 * gave up (or are not retried by anything else), and no per-feature list of
 * keys is needed to find them.
 */
export function invalidateEnvironmentUnavailableQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query: Query) =>
      query.state.status === 'error' && isEnvironmentUnavailableError(query.state.error),
  });
}
