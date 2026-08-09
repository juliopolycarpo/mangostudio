/**
 * The ordering rules for one external session's event stream, stated once.
 *
 * Every later feature — steering, usage, reconnect, session adoption — reads
 * this same stream. If each invented its own retry and dedup rules they would
 * be subtly incompatible, and the resulting bugs are the kind that only appear
 * under load. So the rules live here, as a pure state machine with no database,
 * no runtime client and no clock:
 *
 * - **Monotonic per session.** Sequence starts at one and counts events for the
 *   *session*, not the turn — the runtime numbers them that way, so a second
 *   turn continues where the first stopped. Anything at or below the highest
 *   applied sequence is a redelivery and is dropped as a no-op, not an error.
 * - **A gap is loss, not a reordering.** The transport is ordered, so a skipped
 *   sequence means events the hub will never see. Guessing what they were is
 *   how a partial transcript becomes a wrong one; the turn is reconciled
 *   instead.
 * - **Terminal events are final.** After `completed` or `error` for a native
 *   turn, every later event for that turn is dropped. A vendor that keeps
 *   talking after saying it was done does not get to reopen a persisted turn.
 * - **Foreign turns are not this turn's business.** An envelope for a native
 *   turn other than the live one belongs to a turn that already ended, or to
 *   one this consumer never started.
 */

import type { ExternalAgentEventEnvelope } from '@mangostudio/shared/external-agents';

export type ExternalEnvelopeVerdict =
  | { readonly kind: 'apply' }
  /** Same sequence seen before, or an `idempotencyKey` already applied. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'gap'; readonly expected: number; readonly received: number }
  | { readonly kind: 'after-terminal'; readonly nativeTurnId: string }
  | { readonly kind: 'foreign-turn'; readonly nativeTurnId: string | undefined };

/**
 * How many recent idempotency keys to remember.
 *
 * Nothing produces one yet — the envelope reserves the field for a producer
 * that needs to retry — so this only has to cover a redelivery window, not a
 * whole turn. Unbounded would make a vendor's delta stream a memory leak.
 */
const IDEMPOTENCY_WINDOW = 512;

/**
 * Per-session ordering state. One instance lives as long as the session, across
 * however many turns it runs.
 */
export class ExternalEventSequencer {
  #lastAppliedSequence: number;
  #liveTurnId: string | undefined;
  readonly #terminalTurnIds = new Set<string>();
  readonly #appliedKeys = new Set<string>();

  constructor(lastAppliedSequence = 0) {
    this.#lastAppliedSequence = lastAppliedSequence;
  }

  get lastAppliedSequence(): number {
    return this.#lastAppliedSequence;
  }

  /**
   * Binds the sequencer to the native turn now running. Events carrying any
   * other turn id are `foreign-turn` until this is called again.
   */
  beginTurn(nativeTurnId: string): void {
    this.#liveTurnId = nativeTurnId;
    this.#terminalTurnIds.delete(nativeTurnId);
  }

  /**
   * Records that a native turn reached a terminal state. Later events for it are
   * dropped rather than reopening a turn that has already been written.
   */
  endTurn(nativeTurnId: string): void {
    this.#terminalTurnIds.add(nativeTurnId);
    if (this.#liveTurnId === nativeTurnId) this.#liveTurnId = undefined;
  }

  /**
   * Decides what to do with one envelope and advances the cursor when — and only
   * when — the verdict is `apply`. A rejected envelope leaves the state
   * untouched, so a duplicate is idempotent and a gap stays observable to the
   * caller that has to reconcile it.
   */
  admit(envelope: ExternalAgentEventEnvelope): ExternalEnvelopeVerdict {
    if (envelope.sequence <= this.#lastAppliedSequence) return { kind: 'duplicate' };

    const expected = this.#lastAppliedSequence + 1;
    if (envelope.sequence !== expected) {
      return { kind: 'gap', expected, received: envelope.sequence };
    }

    // Checked only once the envelope is known to be in order, and it still
    // advances: a producer that retried an event under a new sequence has
    // delivered that sequence, and leaving the cursor behind would make the
    // *next* envelope look like loss and terminate a healthy turn.
    if (envelope.idempotencyKey && this.#appliedKeys.has(envelope.idempotencyKey)) {
      this.#advance(envelope);
      return { kind: 'duplicate' };
    }

    const nativeTurnId = envelope.nativeTurnId;
    if (nativeTurnId !== undefined && this.#terminalTurnIds.has(nativeTurnId)) {
      // The sequence still advances: the event was delivered in order and
      // dropping it must not make the *next* one look like a gap.
      this.#advance(envelope);
      return { kind: 'after-terminal', nativeTurnId };
    }
    if (this.#liveTurnId !== undefined && nativeTurnId !== this.#liveTurnId) {
      this.#advance(envelope);
      return { kind: 'foreign-turn', nativeTurnId };
    }

    this.#advance(envelope);
    return { kind: 'apply' };
  }

  #advance(envelope: ExternalAgentEventEnvelope): void {
    this.#lastAppliedSequence = envelope.sequence;
    if (!envelope.idempotencyKey) return;
    // A plain insertion-ordered set is enough for a window this small: the
    // oldest key is the first one iteration yields.
    this.#appliedKeys.add(envelope.idempotencyKey);
    if (this.#appliedKeys.size <= IDEMPOTENCY_WINDOW) return;
    const oldest = this.#appliedKeys.values().next();
    if (!oldest.done) this.#appliedKeys.delete(oldest.value);
  }
}
