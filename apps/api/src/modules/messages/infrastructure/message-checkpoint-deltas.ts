import type { MessagePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { decodeMessageParts } from './message-parts-codec';

const logger = createDiagnosticLogger('messages');

/** One change to a part, addressed by its index in the message's `parts`. */
export type CheckpointPartOp =
  /** Writes the part at `i`: a new part, a tool result, or a part whose state moved. */
  | { readonly i: number; readonly part: MessagePart }
  /** Extends the `text` or `thinking` part at `i`; the part itself is not repeated. */
  | { readonly i: number; readonly append: string };

/**
 * What a streaming turn changed since its previous checkpoint. Stored one row
 * per checkpoint in `message_checkpoint_deltas` and replayed over the
 * `messages` row, so a checkpoint writes the new text and the new tool result
 * once instead of rewriting everything the turn has produced so far.
 */
export interface CheckpointDelta {
  /** Appended to the message `text`. */
  readonly text?: string;
  readonly ops?: readonly CheckpointPartOp[];
  /** Present only when the durable provider state changed (`null` clears it). */
  readonly providerState?: string | null;
  readonly generationTime?: string | null;
}

/** The mutable columns of a generating message that a checkpoint owns. */
export interface CheckpointedContent {
  readonly text: string;
  readonly parts: MessagePart[];
  readonly providerState: string | null;
  readonly generationTime: string | null;
}

/**
 * Replays `deltas` (in order) over `base` and returns the message the writer
 * had at its last checkpoint. `base` is not modified.
 *
 * @example
 * foldCheckpointDeltas(
 *   { text: '', parts: [{ type: 'text', text: 'he' }], providerState: null, generationTime: null },
 *   [{ text: 'llo', ops: [{ i: 0, append: 'llo' }] }]
 * ); // text 'llo', parts [{ type: 'text', text: 'hello' }]
 */
export function foldCheckpointDeltas(
  base: CheckpointedContent,
  deltas: readonly CheckpointDelta[]
): CheckpointedContent {
  const parts = [...base.parts];
  let text = base.text;
  let providerState = base.providerState;
  let generationTime = base.generationTime;
  for (const delta of deltas) {
    if (delta.text) text += delta.text;
    for (const op of delta.ops ?? []) {
      if ('part' in op) {
        parts[op.i] = op.part;
        continue;
      }
      const target = parts[op.i];
      if (target?.type === 'text' || target?.type === 'thinking') {
        parts[op.i] = { ...target, text: target.text + op.append };
      }
    }
    if ('providerState' in delta) providerState = delta.providerState ?? null;
    if ('generationTime' in delta) generationTime = delta.generationTime ?? null;
  }
  return { text, parts, providerState, generationTime };
}

/**
 * Inserts one checkpoint delta. The row only lands while the message is still
 * generating, so a write that loses the race with a finalizer leaves nothing
 * behind. Resolves to whether a row was written.
 */
export async function insertCheckpointDelta(
  input: { readonly messageId: string; readonly seq: number; readonly deltaJson: string },
  db: Kysely<Database>
): Promise<boolean> {
  const result = await db
    .insertInto('message_checkpoint_deltas')
    .columns(['messageId', 'seq', 'delta'])
    .expression((eb) =>
      eb
        .selectFrom('messages')
        .select([
          eb.val(input.messageId).as('messageId'),
          eb.val(input.seq).as('seq'),
          eb.val(input.deltaJson).as('delta'),
        ])
        .where('id', '=', input.messageId)
        .where('isGenerating', '=', 1)
    )
    .executeTakeFirst();
  return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

/**
 * Replaces the checkpointed columns of a generating message with a full
 * snapshot and drops the deltas that predate it, in one transaction: the old
 * deltas folded over the new row would repeat text. The delete runs even for a
 * turn's first rewrite, when nothing is expected to be there, so correctness
 * does not depend on this writer being the only one for the message.
 */
export async function rewriteCheckpointedRow(
  input: {
    readonly messageId: string;
    readonly text: string;
    readonly partsJson: string;
    readonly providerState: string | null;
    readonly generationTime: string | null | undefined;
  },
  db: Kysely<Database>
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('messages')
      .set({
        text: input.text,
        parts: input.partsJson,
        providerState: input.providerState,
        generationTime: input.generationTime,
      })
      .where('id', '=', input.messageId)
      .where('isGenerating', '=', 1)
      .execute();
    await trx
      .deleteFrom('message_checkpoint_deltas')
      .where('messageId', '=', input.messageId)
      .execute();
  });
}

/**
 * Runs `read` with the connection held, so a row read and the fold over its
 * deltas see one state. A live writer's rewrite replaces the row and deletes
 * its deltas in one transaction; read as two separate statements, a reader
 * could take the old row and the new deltas and fold text onto a base it was
 * not written over. The hub has one connection, so a transaction keeps the
 * writer out until `read` returns. A caller that is already in a transaction
 * has that guarantee and is passed straight through.
 */
export function withCheckpointSnapshot<T>(
  db: Kysely<Database>,
  read: (db: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.isTransaction ? read(db) : db.transaction().execute(read);
}

/**
 * The deltas of every given message, in application order. A row that does not
 * parse ends that message's list: later rows build on it, so applying them
 * past the gap would invent a state the turn never had.
 */
async function listCheckpointDeltas(
  messageIds: readonly string[],
  db: Kysely<Database>
): Promise<Map<string, CheckpointDelta[]>> {
  const byMessage = new Map<string, CheckpointDelta[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .selectFrom('message_checkpoint_deltas')
    .select(['messageId', 'seq', 'delta'])
    .where('messageId', 'in', messageIds)
    .orderBy('messageId')
    .orderBy('seq')
    .execute();
  const broken = new Set<string>();
  for (const row of rows) {
    if (broken.has(row.messageId)) continue;
    try {
      const deltas = byMessage.get(row.messageId) ?? [];
      deltas.push(JSON.parse(row.delta) as CheckpointDelta);
      byMessage.set(row.messageId, deltas);
    } catch {
      broken.add(row.messageId);
      logger.warn('corrupt_checkpoint_delta', { messageId: row.messageId, seq: row.seq });
    }
  }
  return byMessage;
}

interface CheckpointedRow {
  readonly id: string;
  readonly text: string;
  readonly parts: string | null;
  readonly providerState: string | null;
  readonly generationTime?: string | null;
  readonly isGenerating: number;
}

/**
 * Returns `rows` with every generating row replaced by the state its last
 * checkpoint reached. Rows that are not generating, and generating rows with no
 * deltas yet, come back untouched. A row whose `parts` cell is damaged is left
 * as stored: the read that reports the damage is not this one.
 *
 * Every reader that can see a generating row goes through here, because the
 * `messages` columns of such a row only hold the turn's last full rewrite.
 */
export async function foldCheckpointDeltasIntoRows<Row extends CheckpointedRow>(
  rows: readonly Row[],
  db: Kysely<Database>
): Promise<Row[]> {
  const generatingIds = rows.filter((row) => row.isGenerating === 1).map((row) => row.id);
  const deltasByMessage = await listCheckpointDeltas(generatingIds, db);
  if (deltasByMessage.size === 0) return [...rows];

  return rows.map((row) => {
    const deltas = deltasByMessage.get(row.id);
    if (!deltas) return row;
    const decoded = decodeMessageParts(row.parts);
    if (decoded.kind === 'corrupt') return row;
    const folded = foldCheckpointDeltas(
      {
        text: row.text,
        parts: decoded.kind === 'ok' ? decoded.parts : [],
        providerState: row.providerState,
        generationTime: row.generationTime ?? null,
      },
      deltas
    );
    return {
      ...row,
      text: folded.text,
      parts: JSON.stringify(folded.parts),
      providerState: folded.providerState,
      ...(row.generationTime === undefined ? {} : { generationTime: folded.generationTime }),
    };
  });
}
