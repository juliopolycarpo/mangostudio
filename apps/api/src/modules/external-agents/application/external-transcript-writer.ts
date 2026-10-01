import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import {
  CHECKPOINT_MAX_INTERVAL_MS,
  CHECKPOINT_TEXT_INTERVAL_CHARS,
} from '../../generation/application/turn-checkpoint';
import type { ExternalTurnTranscript } from '../domain/external-turn-transcript';

const logger = createDiagnosticLogger('external-turn-controller');

function deferToMacrotask(run: () => void): void {
  setTimeout(run, 0);
}

/**
 * Orders the incremental writes for one external assistant row.
 *
 * Same cadence as the internal turn — a character interval and a time interval,
 * with forced writes at durable boundaries — so a dropped connection leaves a
 * readable prefix rather than an empty message, and a delta stream does not turn
 * into one write per token.
 *
 * Writes come in two kinds. A forced write (`write({ force: true })`, a tool or
 * permission boundary) and a {@link writeRequired} (a steering receipt) are
 * required: each is queued in call order and never replaced or merged. A
 * throttled delta write is best-effort: it only records that the latest state is
 * dirty, and one trailing write persists that state. A required write supersedes
 * a dirty best-effort snapshot because it carries newer state.
 *
 * Every write serializes the transcript when it runs, not when it is queued.
 * Deltas that arrive while an earlier write is held therefore share one
 * serialization, and a write queued behind one that failed persists the state
 * with that failure's correction already applied.
 *
 * A trailing write that lands after the turn's final row is a no-op: the update
 * is guarded by `isGenerating = 1`, so a late timer cannot overwrite it.
 *
 * @example
 * const writer = new ExternalTranscriptWriter(db, messageId, transcript, Date.now);
 * void writer.write(); // best-effort: accepted, written on a later tick
 * void writer.write({ force: true }); // required boundary, ordered
 * await writer.writeRequired(); // resolves once written, rejects if the write fails
 * await writer.flush(); // nothing accepted is still waiting to be written
 */
export class ExternalTranscriptWriter {
  #lastTextLength = 0;
  #lastWrittenAt: number;
  #pending: Promise<void> = Promise.resolve();
  /** A best-effort snapshot was accepted and no write has taken it yet. */
  #dirty = false;
  /**
   * Identifies the trailing best-effort write chained on `#pending` but not
   * started. A required write clears it so the stale task cannot run ahead of it.
   */
  #ticket: object | null = null;
  #timerArmed = false;

  /**
   * @param defer Starts `run` on a later macrotask. Best-effort snapshots wait
   *   here so deltas that arrive meanwhile share one write. Defaults to
   *   `setTimeout(run, 0)`.
   */
  constructor(
    private readonly db: Kysely<Database>,
    private readonly messageId: string,
    private readonly transcript: ExternalTurnTranscript,
    private readonly now: () => number,
    private readonly defer: (run: () => void) => void = deferToMacrotask
  ) {
    this.#lastWrittenAt = now();
  }

  /**
   * Requests a write. A forced call is queued in order and resolves once it is
   * written, whether or not it succeeded (a failure is logged). A best-effort
   * call resolves immediately: the throttle decides whether it is accepted, its
   * write happens later and `flush()` waits for it.
   */
  write(options: { readonly force?: boolean } = {}): Promise<void> {
    const at = this.now();
    const text = this.transcript.text;
    const force = options.force === true;
    if (!force && !this.#shouldWrite(text.length, at)) return Promise.resolve();

    this.#lastTextLength = text.length;
    this.#lastWrittenAt = at;
    if (!force) {
      this.#dirty = true;
      this.#armTrailingWrite();
      return Promise.resolve();
    }
    // Best effort at the turn level, exactly like the internal turn's checkpoint
    // writer: a transient database error must neither abort the live turn nor
    // reject every write chained behind it.
    return this.#enqueueRequired().then(undefined, (error: unknown) => {
      logger.warn('checkpoint_write_failed', { messageId: this.messageId, error: String(error) });
    });
  }

  /**
   * A steering attempt cannot reach the vendor unless its durable record did.
   * Unlike ordinary checkpoints, its failure must be observable by the caller.
   *
   * `onFailure` runs synchronously when this write rejects, ahead of any write
   * queued behind it, so a caller can correct the transcript before the next
   * snapshot is taken.
   *
   * @example
   * await writer.writeRequired(() => transcript.resolveSteerRejected(id, 'not-supported'));
   */
  writeRequired(onFailure?: () => void): Promise<void> {
    return this.#enqueueRequired(onFailure);
  }

  /**
   * Resolves once nothing accepted is waiting to be written: every write queued
   * so far has settled and no best-effort snapshot is dirty. State accepted
   * while this waits, and the snapshot a failed required write handed back,
   * are written before it resolves. A write that fails is logged, not retried,
   * so the wait ends even when the database keeps failing. Settled means the
   * write finished, not that it succeeded.
   */
  async flush(): Promise<void> {
    for (;;) {
      if (this.#dirty) this.#queueTrailingWrite();
      const tail = this.#pending;
      await tail;
      // A delta accepted or a failure re-marking state during the wait only
      // sets the dirty flag; it does not extend the chain this loop awaited.
      if (tail === this.#pending && !this.#dirty) return;
    }
  }

  #enqueueRequired(onFailure?: () => void): Promise<void> {
    // This write carries state at least as new as any snapshot still waiting.
    const supersededDirty = this.#dirty;
    this.#dirty = false;
    this.#ticket = null;
    const required = this.#pending
      .then(() => this.#persistSnapshot())
      .then(
        () => undefined,
        (error: unknown) => {
          // Runs before the queue recovers, so a write chained behind this one
          // snapshots the transcript with the correction already applied.
          onFailure?.();
          // The snapshot this write absorbed never reached disk; the trailing
          // write that takes it serializes when it runs.
          if (supersededDirty) this.#markDirty();
          throw error;
        }
      );
    // Keep subsequent writes usable if this one failed; a steering caller still
    // receives the original rejection.
    this.#pending = required.then(
      () => undefined,
      (error: unknown) => {
        logger.warn('required_checkpoint_write_failed', {
          messageId: this.messageId,
          error: String(error),
        });
      }
    );
    return required;
  }

  #markDirty(): void {
    this.#dirty = true;
    this.#armTrailingWrite();
  }

  #armTrailingWrite(): void {
    if (this.#timerArmed || this.#ticket) return;
    this.#timerArmed = true;
    this.defer(() => {
      this.#timerArmed = false;
      if (this.#dirty) this.#queueTrailingWrite();
    });
  }

  #queueTrailingWrite(): void {
    if (this.#ticket) return;
    const ticket = {};
    this.#ticket = ticket;
    // The snapshot is taken when this write starts, not now: everything accepted
    // while an earlier write was held collapses into this one.
    this.#pending = this.#pending.then(async () => {
      if (this.#ticket !== ticket) return;
      this.#ticket = null;
      if (!this.#dirty) return;
      this.#dirty = false;
      try {
        await this.#persistSnapshot();
      } catch (error) {
        logger.warn('checkpoint_write_failed', {
          messageId: this.messageId,
          error: String(error),
        });
      }
    });
  }

  /**
   * Serialized when the write runs, not when it is queued: a write queued behind
   * one that failed would otherwise persist a snapshot that predates the
   * failure's correction. `isGenerating = 1` keeps a late write from touching a
   * row the turn's final write already sealed.
   */
  #persistSnapshot() {
    const text = this.transcript.text;
    const parts = JSON.stringify(this.transcript.parts);
    return this.db
      .updateTable('messages')
      .set({ text, parts })
      .where('id', '=', this.messageId)
      .where('isGenerating', '=', 1)
      .execute();
  }

  #shouldWrite(textLength: number, at: number): boolean {
    return (
      textLength - this.#lastTextLength >= CHECKPOINT_TEXT_INTERVAL_CHARS ||
      at - this.#lastWrittenAt >= CHECKPOINT_MAX_INTERVAL_MS
    );
  }
}
