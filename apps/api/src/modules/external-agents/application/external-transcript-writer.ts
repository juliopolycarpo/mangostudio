import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import {
  CHECKPOINT_MAX_INTERVAL_MS,
  CHECKPOINT_TEXT_INTERVAL_CHARS,
} from '../../generation/application/turn-checkpoint';
import type { ExternalTurnTranscript } from '../domain/external-turn-transcript';

const logger = createDiagnosticLogger('external-turn-controller');

/**
 * Serializes the incremental writes for one assistant row.
 *
 * Same cadence as the internal turn — a character interval and a time interval,
 * with forced writes at durable boundaries — so a dropped connection leaves a
 * readable prefix rather than an empty message, and a delta stream does not turn
 * into one write per token.
 */
export class ExternalTranscriptWriter {
  #lastTextLength = 0;
  #lastWrittenAt: number;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly messageId: string,
    private readonly transcript: ExternalTurnTranscript,
    private readonly now: () => number
  ) {
    this.#lastWrittenAt = now();
  }

  write(options: { readonly force?: boolean } = {}): Promise<void> {
    const at = this.now();
    const text = this.transcript.text;
    if (options.force !== true && !this.#shouldWrite(text.length, at)) return this.#pending;

    this.#lastTextLength = text.length;
    this.#lastWrittenAt = at;
    this.#pending = this.#pending
      .then(() => this.#persistSnapshot())
      .then(
        () => undefined,
        (error: unknown) => {
          // Best effort, exactly like the internal turn's checkpoint writer: a
          // transient database error must neither abort the live turn nor
          // reject every write chained behind it.
          logger.warn('checkpoint_write_failed', {
            messageId: this.messageId,
            error: String(error),
          });
        }
      );
    return this.#pending;
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
    const required = this.#pending
      .then(() => this.#persistSnapshot())
      .then(
        () => undefined,
        (error: unknown) => {
          // Runs before the queue recovers, so a write chained behind this one
          // snapshots the transcript with the correction already applied.
          onFailure?.();
          throw error;
        }
      );
    // Keep subsequent best-effort checkpoints usable if this required write
    // failed; the steering caller still receives the original rejection.
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

  flush(): Promise<void> {
    return this.#pending;
  }

  /**
   * Serialized when the write runs, not when it is queued: a write queued behind
   * one that failed would otherwise persist a snapshot that predates the
   * failure's correction.
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
