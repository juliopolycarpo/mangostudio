/**
 * Pure decisions for resubmitting an external turn: how one failed submission
 * is classified, and how long to wait before the next one.
 *
 * Kept free of I/O so each rule is tested on its own; the loop that applies
 * them is `external-turn-submission.ts`.
 */

import { RemoteError } from '@mangostudio/protocol';
import { isRequestNotSent, noReplyOf } from '../../../services/runtime-client/request-not-sent';

export interface RetryPolicy {
  /** First backoff, before jitter. */
  readonly baseDelayMs: number;
  /** No single wait exceeds this. */
  readonly maxDelayMs: number;
}

/**
 * How much of a computed delay jitter may remove. A band rather than full
 * jitter, as in the SDK's hub-host reference: full jitter makes the delays
 * non-monotonic, so a turn could wait less after its fifth failure than after
 * its first.
 */
const JITTER_SPREAD = 0.25;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/**
 * What one failed `external-agent.turn` request proves.
 *
 * - `not-submitted`: nothing reached the vendor — the hub never wrote the frame,
 *   or the runtime said so (`details.dispatch === "not-submitted"`).
 * - `no-reply`: the hub itself saw no answer — its deadline passed, or its
 *   connection closed. The request may have been received.
 * - `acceptance-unknown`: the runtime answered that it cannot say whether the
 *   vendor took the turn (`details.dispatch === "acceptance-unknown"`).
 * - `refused`: any other answer the runtime sent, whatever its code. A
 *   runtime-sent `UNAVAILABLE`, `TIMEOUT` or `CANCELLED` is a committed outcome
 *   it replays from its receipt, so resending it would only spin.
 */
export type SubmissionFailure = 'not-submitted' | 'no-reply' | 'acceptance-unknown' | 'refused';

/**
 * Classifies a rejected submission. Only failures the hub itself observed are
 * `no-reply`; everything that came over the wire is the runtime's answer.
 *
 * @example
 * classifySubmissionFailure(new RemoteError('UNAVAILABLE', 'signed out')); // 'refused'
 */
export function classifySubmissionFailure(error: unknown): SubmissionFailure {
  if (isRequestNotSent(error)) return 'not-submitted';
  if (noReplyOf(error)) return 'no-reply';
  const dispatch = error instanceof RemoteError ? error.details?.dispatch : undefined;
  if (dispatch === 'not-submitted') return 'not-submitted';
  if (dispatch === 'acceptance-unknown') return 'acceptance-unknown';
  return 'refused';
}

/**
 * Whether a `no-reply` failure also proves the connection it was sent on is
 * gone, and with it every receipt that could have answered a resend.
 *
 * @example
 * failureClosedConnection(error); // true when the hub's own session closed under it
 */
export function failureClosedConnection(error: unknown): boolean {
  return noReplyOf(error)?.reason === 'connection-closed';
}

/**
 * Capped exponential backoff with jitter for the `retry`-th wait (0-based).
 * `random` is in [0, 1]; the result is in [75%, 100%] of the capped delay, so
 * a wait never collapses to zero and never shrinks as failures grow.
 *
 * @example
 * backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0.5); // 875
 */
export function backoffDelay(retry: number, policy: RetryPolicy, random: () => number): number {
  const exponent = Math.min(Math.max(retry, 0), 30);
  const capped = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
  const fraction = Math.min(Math.max(random(), 0), 1);
  return Math.round(capped * (1 - JITTER_SPREAD + JITTER_SPREAD * fraction));
}
