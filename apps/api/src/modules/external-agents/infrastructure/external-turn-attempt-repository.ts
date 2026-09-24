/**
 * Durable receipts for external-turn submissions (`external_turn_attempts`).
 *
 * Every state change is a compare-and-set: `transitionAttempt` only writes
 * when the row is still in one of the states the caller expected. That is
 * what stops a late reply to an attempt the hub already gave up on from
 * reviving it, and what stops two writers from both believing they won.
 */

import { type Kysely, sql } from 'kysely';
import type {
  Database,
  ExternalTurnAttemptInsert,
  ExternalTurnAttemptSelect,
  ExternalTurnAttemptState,
  ExternalTurnAttemptUpdate,
} from '../../../db/types';

/**
 * Records an attempt before it is submitted. Always `acceptance-unknown`: the
 * hub cannot know yet whether the runtime will receive it.
 *
 * @example
 * await insertAttempt({ id, messageId, chatId, ..., createdAt: now, updatedAt: now }, db);
 */
export async function insertAttempt(
  row: Omit<ExternalTurnAttemptInsert, 'state' | 'nativeTurnId' | 'terminalReason'>,
  db: Kysely<Database>
): Promise<void> {
  await db
    .insertInto('external_turn_attempts')
    .values({ ...row, state: 'acceptance-unknown', nativeTurnId: null, terminalReason: null })
    .execute();
}

/**
 * Moves an attempt to `to` only if it is still in one of `from`. Returns
 * whether this call won.
 *
 * @example
 * const won = await transitionAttempt(id, ['acceptance-unknown'], 'accepted', { nativeTurnId, at }, db);
 */
export async function transitionAttempt(
  id: string,
  from: readonly ExternalTurnAttemptState[],
  to: ExternalTurnAttemptState,
  patch: {
    readonly at: number;
    readonly nativeTurnId?: string;
    readonly terminalReason?: string;
  },
  db: Kysely<Database>
): Promise<boolean> {
  const update: ExternalTurnAttemptUpdate = {
    state: to,
    updatedAt: patch.at,
    ...(patch.nativeTurnId !== undefined ? { nativeTurnId: patch.nativeTurnId } : {}),
    ...(patch.terminalReason !== undefined ? { terminalReason: patch.terminalReason } : {}),
  };
  const result = await db
    .updateTable('external_turn_attempts')
    .set(update)
    .where('id', '=', id)
    .where('state', 'in', [...from])
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/**
 * Every attempt for one logical operation, in the order they were recorded.
 *
 * @example
 * const attempts = await listAttemptsForMessage(messageId, db);
 */
export async function listAttemptsForMessage(
  messageId: string,
  db: Kysely<Database>
): Promise<ExternalTurnAttemptSelect[]> {
  return await db
    .selectFrom('external_turn_attempts')
    .selectAll()
    .where('messageId', '=', messageId)
    // Insertion order: several attempts can share a millisecond.
    .orderBy(sql`rowid`, 'asc')
    .execute();
}

/**
 * The idempotent terminal checkpoint for one logical operation: every attempt
 * still open gets its final state. An attempt that may have been accepted but
 * never confirmed becomes `unresolved`; the rest become `terminal`. A second
 * call changes nothing.
 *
 * @example
 * await sealAttemptsForMessage(messageId, 'completed', Date.now(), db);
 */
export async function sealAttemptsForMessage(
  messageId: string,
  reason: string,
  at: number,
  db: Kysely<Database>
): Promise<void> {
  await db
    .updateTable('external_turn_attempts')
    .set({ state: 'unresolved', terminalReason: reason, updatedAt: at })
    .where('messageId', '=', messageId)
    .where('state', '=', 'acceptance-unknown')
    .execute();
  await db
    .updateTable('external_turn_attempts')
    .set({ state: 'terminal', terminalReason: reason, updatedAt: at })
    .where('messageId', '=', messageId)
    .where('state', 'in', ['not-submitted', 'accepted'])
    .execute();
}
