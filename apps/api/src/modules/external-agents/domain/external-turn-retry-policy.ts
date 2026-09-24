/**
 * Pure decisions for resubmitting an external turn: how one failed submission
 * is classified, how long to wait before the next one, and how a runtime's
 * retry hint may stretch that wait.
 *
 * Kept free of I/O so each rule is tested on its own; the loop that applies
 * them is `external-turn-submission.ts`.
 */

import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import { isRequestNotSent } from '../../../services/runtime-client/request-not-sent';
import { ToolExecutionTimedOutError } from '../../../services/tools/execution-timeout';

export interface RetryPolicy {
  /** First backoff, before jitter. */
  readonly baseDelayMs: number;
  /** No single wait exceeds this, hint or not. */
  readonly maxDelayMs: number;
  /** Deadline for one submission request. */
  readonly attemptTimeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  attemptTimeoutMs: 30_000,
};

/**
 * What one failed `external-agent.turn` request proves.
 *
 * - `not-submitted`: nothing reached the vendor — the hub never wrote the frame,
 *   or the runtime said so (`details.dispatch === "not-submitted"`).
 * - `no-reply`: the request may have been received; the reply never came.
 * - `refused`: the runtime answered with an error. That is a committed outcome.
 */
export type SubmissionFailure = 'not-submitted' | 'no-reply' | 'refused';

/**
 * Classifies a rejected submission. Anything ambiguous is `no-reply`, the
 * direction that can never cause a second submission.
 *
 * @example
 * classifySubmissionFailure(new ToolExecutionTimedOutError('late')); // 'no-reply'
 */
export function classifySubmissionFailure(error: unknown): SubmissionFailure {
  if (isRequestNotSent(error)) return 'not-submitted';
  if (error instanceof RemoteError && error.details?.dispatch === 'not-submitted') {
    return 'not-submitted';
  }
  if (error instanceof ToolExecutionTimedOutError) return 'no-reply';
  if (error instanceof RemoteError && error.code === RESERVED_ERROR_CODES.UNAVAILABLE) {
    return 'no-reply';
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'no-reply';
  return 'refused';
}

/**
 * Whether a `no-reply` failure also proves the connection it was sent on is
 * gone — the SDK names the close code when a close rejected the request.
 *
 * @example
 * failureClosedConnection(new RemoteError('UNAVAILABLE', 'closed', { closeCode: 1001 })); // true
 */
export function failureClosedConnection(error: unknown): boolean {
  return error instanceof RemoteError && error.details?.closeCode !== undefined;
}

/**
 * Capped exponential backoff with jitter for the `retry`-th wait (0-based).
 * `random` is in [0, 1); the result is in [half, full] of the capped delay, so
 * a wait never collapses to zero.
 *
 * @example
 * backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0.5); // 750
 */
export function backoffDelay(retry: number, policy: RetryPolicy, random: () => number): number {
  const exponent = Math.min(Math.max(retry, 0), 30);
  const capped = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
  const fraction = Math.min(Math.max(random(), 0), 1);
  return Math.round(capped / 2 + (capped / 2) * fraction);
}

/**
 * The wait before the next attempt once a runtime's hint is taken into
 * account.
 *
 * A hint asks for a *longer* wait; it never permits a shorter one, and it
 * never stretches a wait past the cap. `hintAtMs` is an absolute epoch-ms
 * instant, resolved against `nowMs`. A missing, non-finite or past hint leaves
 * the computed delay unchanged.
 *
 * @example
 * clampRetryHint({ computedDelayMs: 1_000, maxDelayMs: 30_000, hintAtMs: 5_000, nowMs: 0 }); // 5_000
 */
export function clampRetryHint(input: {
  readonly computedDelayMs: number;
  readonly maxDelayMs: number;
  readonly hintAtMs?: number;
  readonly nowMs: number;
}): number {
  const floor = Math.min(input.computedDelayMs, input.maxDelayMs);
  if (input.hintAtMs === undefined || !Number.isFinite(input.hintAtMs)) return floor;
  const requested = input.hintAtMs - input.nowMs;
  return Math.min(Math.max(floor, requested), input.maxDelayMs);
}

/**
 * The runtime's retry hint, if it sent one as `details.retryAfterMs` (epoch ms).
 *
 * @example
 * retryHintOf(new RemoteError('UNAVAILABLE', 'busy', { retryAfterMs: 1_700 })); // 1_700
 */
export function retryHintOf(error: unknown): number | undefined {
  if (!(error instanceof RemoteError)) return undefined;
  const hint = error.details?.retryAfterMs;
  return typeof hint === 'number' && Number.isFinite(hint) ? hint : undefined;
}
