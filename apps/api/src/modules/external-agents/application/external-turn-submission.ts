/**
 * Submits one external turn to a runtime, at most once, and keeps trying until
 * the answer is known.
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
 *    `not-submitted` and is retried after a capped, jittered backoff with no
 *    count cutoff.
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
import type { ExternalAgentTurnParams } from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { isRequestNotSent } from '../../../services/runtime-client/request-not-sent';
import {
  backoffDelay,
  clampRetryHint,
  classifySubmissionFailure,
  failureClosedConnection,
  type RetryPolicy,
  retryHintOf,
} from '../domain/external-turn-retry-policy';
import {
  insertAttempt,
  transitionAttempt,
} from '../infrastructure/external-turn-attempt-repository';
import type { ExternalSessionHandle, ExternalTurnInput } from './external-session-manager';

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
export function fingerprintTurnParams(params: ExternalAgentTurnParams): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(params)).digest('hex')}`;
}

export type SubmissionOutcome =
  | { readonly kind: 'accepted'; readonly nativeTurnId: string; readonly attemptId: string }
  /** The runtime may or may not have the turn; nothing can reconcile it now. */
  | { readonly kind: 'unresolved'; readonly attemptId: string }
  /** The runtime, or the session open, refused the turn. */
  | { readonly kind: 'refused'; readonly error: unknown }
  /** The pre-submission receipt could not be written; nothing was sent. */
  | { readonly kind: 'receipt-failed'; readonly error: unknown }
  /** `signal` aborted. The caller already knows why. */
  | { readonly kind: 'stopped' };

export interface SubmitExternalTurnInput {
  readonly db: Kysely<Database>;
  readonly messageId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly environmentId: string;
  readonly turn: ExternalTurnInput;
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
}

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
  let handle: ExternalSessionHandle | undefined = input.handle;
  let retries = 0;

  const wait = async (hintAtMs?: number): Promise<void> => {
    const computed = backoffDelay(retries, input.policy, input.random);
    retries += 1;
    const ms = clampRetryHint({
      computedDelayMs: computed,
      maxDelayMs: input.policy.maxDelayMs,
      nowMs: input.now(),
      ...(hintAtMs !== undefined ? { hintAtMs } : {}),
    });
    await input.sleep(ms, input.signal);
  };

  while (!input.signal.aborted) {
    if (!handle?.isLive()) {
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
        await wait(retryHintOf(error));
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

/** One attempt: one receipt, one params object, resent only on the same connection. */
async function runAttempt(
  input: SubmitExternalTurnInput,
  handle: ExternalSessionHandle,
  wait: (hintAtMs?: number) => Promise<void>
): Promise<AttemptResult> {
  const params = handle.turnParams(input.turn);
  const attemptId = input.newId();
  const revision = handle.connectionRevision;
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
        connectionRevision: revision,
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

  let sent = false;
  while (true) {
    if (input.signal.aborted) {
      await settle('terminal', 'stopped');
      return { kind: 'done', outcome: { kind: 'stopped' } };
    }
    let nativeTurnId: string;
    try {
      nativeTurnId = await handle.sendTurn(params);
    } catch (error) {
      const failure = classifySubmissionFailure(error);
      if (failure === 'not-submitted' && !sent) {
        await settle('not-submitted');
        await wait(retryHintOf(error));
        return { kind: 'retry' };
      }
      if (failure === 'refused') {
        await settle('terminal', 'refused');
        return { kind: 'done', outcome: { kind: 'refused', error } };
      }
      // Sent at least once, no answer. Reconcilable only on the connection
      // whose receipts could answer a resend.
      sent = true;
      // A resend the hub could not write proves the session closed, and with it
      // the receipt that could have answered.
      const sameConnection =
        !isRequestNotSent(error) &&
        !failureClosedConnection(error) &&
        handle.isLive() &&
        handle.connectionRevision === revision;
      if (!sameConnection) {
        if (input.signal.aborted) continue;
        await settle('unresolved', 'acceptance-unknown');
        return { kind: 'done', outcome: { kind: 'unresolved', attemptId } };
      }
      await wait(retryHintOf(error));
      continue;
    }

    if (input.signal.aborted) {
      await settle('terminal', 'stopped');
      input.onLateAcceptance(handle, nativeTurnId);
      return { kind: 'done', outcome: { kind: 'stopped' } };
    }
    const won = await transitionAttempt(
      attemptId,
      ['acceptance-unknown'],
      'accepted',
      { at: input.now(), nativeTurnId },
      input.db
    );
    if (!won) {
      // The turn already ended here; the vendor's copy of it must end too.
      input.onLateAcceptance(handle, nativeTurnId);
      return { kind: 'done', outcome: { kind: 'stopped' } };
    }
    return { kind: 'done', outcome: { kind: 'accepted', nativeTurnId, attemptId } };
  }
}
