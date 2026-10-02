/**
 * Submits one external turn or native review to a runtime, at most once,
 * and reconciles its acceptance before binding the vendor turn.
 *
 * The rules this loop holds, in the order they are applied:
 *
 * 1. **Receipt before submission.** Each attempt is recorded as
 *    `acceptance-unknown` before its request is sent. A failed write sends
 *    nothing.
 * 2. **Exact params.** An attempt's params are built once and resent byte for
 *    byte, so a runtime answers a repeat from its `clientMessageId` receipt
 *    instead of starting a second vendor turn. Only the digest is persisted.
 * Each request is bounded by the session manager's call deadline (30 s), which
 * is the per-attempt bound; a deadline that fires is a sent request with no
 * reply, never a vendor error.
 *
 * 3. **Replay only what was proven not submitted.** A request the hub never
 *    wrote, or one the runtime said it did not dispatch, becomes
 *    `not-submitted`; an ordinary turn is retried after a capped, jittered
 *    backoff with no count cutoff. A native review retains its one-call refusal policy.
 * 4. **Reconcile what may have been accepted.** A sent request with no reply
 *    is resent unchanged while its connection is still the same one — the
 *    runtime's receipt answers it. Once that connection is gone the receipts
 *    went with it, so the attempt is `unresolved` and never resent: guessing
 *    either way could run the user's work twice or silently drop it.
 * 5. **A runtime's answer is final.** An error reply is a committed refusal.
 * 6. **Stopping wins.** Abort, revocation and shutdown end the loop through
 *    `signal`; every state write is a compare-and-set, so a reply that arrives
 *    afterwards cannot revive the attempt.
 */

import { createHash } from 'node:crypto';
import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import type {
  ExternalAgentStartReviewParams,
  ExternalAgentTurnParams,
} from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { isRequestNotSent } from '../../../services/runtime-client/request-not-sent';
import {
  backoffDelay,
  classifySubmissionFailure,
  failureClosedConnection,
  type RetryPolicy,
} from '../domain/external-turn-retry-policy';
import {
  insertAttempt,
  transitionAttempt,
} from '../infrastructure/external-turn-attempt-repository';
import type {
  ExternalReviewInput,
  ExternalSessionHandle,
  ExternalTurnInput,
} from './external-session-manager';

const logger = createDiagnosticLogger('external-turn-submission');

/** Waits `ms`, or rejects nothing and resolves early when `signal` aborts. */
export type CancellableSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * The production sleep: a timer cleared by the abort.
 *
 * @example
 * await sleepUnlessAborted(1_000, controller.signal);
 */
export const sleepUnlessAborted: CancellableSleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * sha256 of the params exactly as they are serialized onto the wire.
 *
 * @example
 * fingerprintTurnParams(params); // 'sha256:3f…'
 */
export function fingerprintTurnParams(
  params: ExternalAgentTurnParams | ExternalAgentStartReviewParams
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(params)).digest('hex')}`;
}

export type SubmissionOutcome =
  | { readonly kind: 'accepted'; readonly nativeTurnId: string; readonly attemptId: string }
  /** The runtime may or may not have the turn; nothing can reconcile it now. */
  | { readonly kind: 'unresolved'; readonly attemptId: string; readonly error?: unknown }
  /** The runtime, or the session open, refused the turn. */
  | { readonly kind: 'refused'; readonly error: unknown }
  /** The pre-submission receipt could not be written; nothing was sent. */
  | { readonly kind: 'receipt-failed'; readonly error: unknown }
  /** `signal` aborted. The caller already knows why. */
  | { readonly kind: 'stopped' };

interface SubmissionContext {
  readonly db: Kysely<Database>;
  readonly messageId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly environmentId: string;
  /** The session to submit on first. */
  readonly handle: ExternalSessionHandle;
  /**
   * A live session for the next attempt once `handle` is gone. Rejects when no
   * connection is available yet; the loop waits and asks again.
   */
  readonly reacquire: () => Promise<ExternalSessionHandle>;
  /** True for a connect failure that no amount of waiting fixes (a protocol mismatch). */
  readonly isTerminalConnectFailure: (error: unknown) => boolean;
  readonly signal: AbortSignal;
  readonly policy: RetryPolicy;
  readonly now: () => number;
  readonly newId: () => string;
  readonly random: () => number;
  readonly sleep: CancellableSleep;
  /** The accepted turn arrived after `signal` aborted; the vendor must be told to stop. */
  readonly onLateAcceptance: (handle: ExternalSessionHandle, nativeTurnId: string) => void;
  /**
   * Whether the latest attempt may have reached the runtime: true from the
   * moment its request is handed to the transport until it is proven
   * not-submitted or settled. A turn stopped while this is true cannot say
   * the vendor never had it.
   */
  readonly onDispatchPending?: (pending: boolean) => void;
}

/** One turn or native review; both use the existing durable attempt ledger. */
export type SubmitExternalTurnInput = SubmissionContext &
  (
    | { readonly turn: ExternalTurnInput; readonly review?: never }
    | { readonly review: ExternalReviewInput; readonly turn?: never }
  );

/** A session open that failed because the connection is not there yet, not because it was refused. */
function isConnectionUnavailable(error: unknown): boolean {
  return error instanceof RemoteError && error.code === RESERVED_ERROR_CODES.UNAVAILABLE;
}

/**
 * Runs the submission loop to one outcome.
 *
 * @example
 * const outcome = await submitExternalTurn({ db, messageId, handle, turn, signal, ... });
 * if (outcome.kind === 'accepted') handle.beginTurn(outcome.nativeTurnId);
 */
export async function submitExternalTurn(
  input: SubmitExternalTurnInput
): Promise<SubmissionOutcome> {
  let handle = input.handle;
  let retries = 0;

  const wait = async (): Promise<void> => {
    const ms = backoffDelay(retries, input.policy, input.random);
    retries += 1;
    await input.sleep(ms, input.signal);
  };

  while (!input.signal.aborted) {
    // A review stays on its selected vendor thread and opened configuration.
    if (!input.review && !handle.isLive()) {
      try {
        handle = await input.reacquire();
      } catch (error) {
        if (input.signal.aborted) break;
        if (input.isTerminalConnectFailure(error) || !isConnectionUnavailable(error)) {
          return { kind: 'refused', error };
        }
        // Includes an environment latched after repeated connect failures: the
        // loop keeps waiting for someone to reconnect it rather than forcing a
        // connect itself or treating the latch as the end.
        logger.info('submission_waiting_for_connection', { messageId: input.messageId });
        await wait();
        continue;
      }
      if (input.signal.aborted) break;
    }

    const attempt = await runAttempt(input, handle, wait);
    if (attempt.kind === 'retry') continue;
    return attempt.outcome;
  }
  return { kind: 'stopped' };
}

type AttemptResult =
  | { readonly kind: 'retry' }
  | { readonly kind: 'done'; readonly outcome: SubmissionOutcome };

/** Builds one ordinary turn request; the closure always sends the same params. */
function turnRequest(handle: ExternalSessionHandle, input: ExternalTurnInput) {
  const params = handle.turnParams(input);
  return { params, send: () => handle.sendTurn(params) };
}

/**
 * Builds a review on the session's existing policy. Every supported runtime
 * offering nativeReview has fingerprinted start-review receipts, including
 * the former TypeScript host; the method/capability boundary is unchanged.
 */
function reviewRequest(handle: ExternalSessionHandle, input: ExternalReviewInput) {
  const params = handle.reviewParams(input);
  return { params, send: () => startReviewTurn(handle, params) };
}

/**
 * Starts the review and verifies its events belong to the session being observed.
 * A detached thread is cancelled rather than bound to the wrong transcript.
 */
async function startReviewTurn(
  handle: ExternalSessionHandle,
  params: ExternalAgentStartReviewParams
): Promise<string> {
  const started = await handle.sendReview(params);
  if (started.reviewThreadId !== handle.nativeSessionId) {
    await handle.cancel(started.nativeTurnId).catch(() => undefined);
    throw new Error(
      `The review was started on session "${started.reviewThreadId}" instead of this chat's own.`
    );
  }
  return started.nativeTurnId;
}

/** One attempt: one receipt, one params object, resent only on the same connection. */
async function runAttempt(
  input: SubmitExternalTurnInput,
  handle: ExternalSessionHandle,
  wait: () => Promise<void>
): Promise<AttemptResult> {
  const request = input.review
    ? reviewRequest(handle, input.review)
    : turnRequest(handle, input.turn);
  const params = request.params;
  const attemptId = input.newId();
  try {
    await insertAttempt(
      {
        id: attemptId,
        messageId: input.messageId,
        chatId: input.chatId,
        userId: input.userId,
        environmentId: input.environmentId,
        sessionId: params.sessionId,
        clientMessageId: params.clientMessageId,
        inputFingerprint: fingerprintTurnParams(params),
        createdAt: input.now(),
        updatedAt: input.now(),
      },
      input.db
    );
  } catch (error) {
    return { kind: 'done', outcome: { kind: 'receipt-failed', error } };
  }

  const settle = (to: 'terminal' | 'unresolved' | 'not-submitted', reason?: string) =>
    transitionAttempt(
      attemptId,
      ['acceptance-unknown'],
      to,
      { at: input.now(), ...(reason ? { terminalReason: reason } : {}) },
      input.db
    );
  const pending = (value: boolean): void => input.onDispatchPending?.(value);

  /** Whether any request of this attempt was handed to the transport. */
  let dispatched = false;
  /** Whether a request of this attempt went out and was never answered. */
  let unanswered = false;
  while (true) {
    if (input.signal.aborted) {
      // A stop after a request went out cannot claim the vendor never had it.
      await settle(dispatched ? 'unresolved' : 'terminal', 'stopped');
      return { kind: 'done', outcome: { kind: 'stopped' } };
    }
    if (unanswered && !handle.isLive()) {
      await settle('unresolved', 'acceptance-unknown');
      return { kind: 'done', outcome: { kind: 'unresolved', attemptId } };
    }
    let nativeTurnId: string;
    try {
      dispatched = true;
      pending(true);
      nativeTurnId = await request.send();
    } catch (error) {
      const failure = classifySubmissionFailure(error);
      // The hub's own proof covers only this write; after an unanswered send
      // the earlier request may still have landed. The runtime's proof comes
      // from the same receipts every earlier request would have hit.
      const provenAbsent = failure === 'not-submitted' && (!isRequestNotSent(error) || !unanswered);
      if (provenAbsent) {
        await settle('not-submitted');
        pending(false);
        // Preserve review's one-call Busy/NotSubmitted policy. An ordinary
        // turn may retry proven absence, but a review is an explicit action.
        if (input.review) return { kind: 'done', outcome: { kind: 'refused', error } };
        await wait();
        return { kind: 'retry' };
      }
      if (failure === 'refused') {
        await settle('terminal', 'refused');
        pending(false);
        return { kind: 'done', outcome: { kind: 'refused', error } };
      }
      // A resend the hub could not write proves the session closed, and with
      // it the receipt that could have answered; a runtime that says it cannot
      // tell has answered for good.
      const reconcilable =
        failure === 'no-reply' && !failureClosedConnection(error) && handle.isLive();
      unanswered = true;
      if (!reconcilable) {
        if (input.signal.aborted) continue;
        await settle('unresolved', 'acceptance-unknown');
        return {
          kind: 'done',
          outcome: {
            kind: 'unresolved',
            attemptId,
            ...(input.review && failure === 'acceptance-unknown' ? { error } : {}),
          },
        };
      }
      await wait();
      continue;
    }

    if (input.signal.aborted) {
      await recordLateAcceptance(input, attemptId, nativeTurnId);
      input.onLateAcceptance(handle, nativeTurnId);
      return { kind: 'done', outcome: { kind: 'stopped' } };
    }
    let won: boolean;
    try {
      won = await transitionAttempt(
        attemptId,
        ['acceptance-unknown'],
        'accepted',
        { at: input.now(), nativeTurnId },
        input.db
      );
    } catch (error) {
      // The vendor is running a turn nothing here will ever observe.
      input.onLateAcceptance(handle, nativeTurnId);
      throw error;
    }
    if (!won) {
      // The turn already ended here; the vendor's copy of it must end too.
      await recordLateAcceptance(input, attemptId, nativeTurnId);
      input.onLateAcceptance(handle, nativeTurnId);
      return { kind: 'done', outcome: { kind: 'stopped' } };
    }
    pending(false);
    return { kind: 'done', outcome: { kind: 'accepted', nativeTurnId, attemptId } };
  }
}

/**
 * Records what a late reply proved: the vendor did accept this attempt, after
 * the turn had already stopped. The turn stays ended; the receipt stops
 * claiming acceptance is unknown.
 */
async function recordLateAcceptance(
  input: SubmitExternalTurnInput,
  attemptId: string,
  nativeTurnId: string
): Promise<void> {
  await transitionAttempt(
    attemptId,
    ['acceptance-unknown', 'unresolved'],
    'terminal',
    { at: input.now(), nativeTurnId, terminalReason: 'accepted-after-stop' },
    input.db
  ).catch((error: unknown) => {
    logger.warn('late_acceptance_record_failed', { attemptId, error: String(error) });
  });
}
