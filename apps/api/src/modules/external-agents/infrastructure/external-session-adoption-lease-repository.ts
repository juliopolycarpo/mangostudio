/**
 * Who is allowed to write into a native vendor session right now.
 *
 * A vendor session has exactly one transcript. Two MangoStudio chats attached
 * to it would interleave two conversations into that one thread, and neither
 * user would be able to tell which half was theirs — so adoption takes a lease
 * before a chat exists, and a second adoption of a held session is refused.
 *
 * Three properties the shape encodes:
 *
 * - **Keyed by the session, not the chat.** The thing that must not be shared
 *   is the vendor's conversation, whichever chat is doing the sharing.
 * - **It expires.** A hub that crashed holding a lease must not make a session
 *   unadoptable for good, so the claim is a timed one and an expired row is
 *   taken over rather than respected.
 * - **It is refreshed by use.** A live chat keeps its claim by continuing to
 *   open sessions; nothing has to run on a timer to hold it.
 *
 * What a lease cannot do is stop the *user's own terminal* from typing into the
 * same session. Nothing on the hub can see that. It makes the half MangoStudio
 * owns single-writer and gives adoption somewhere to refuse.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';

/** Long enough to outlive a slow vendor start, short enough that a dead hub frees the session. */
export const EXTERNAL_ADOPTION_LEASE_TTL_MS = 30 * 60_000;

export interface ExternalAdoptionLeaseKey {
  readonly environmentId: string;
  readonly targetId: string;
  readonly nativeSessionId: string;
}

export interface ExternalAdoptionLease extends ExternalAdoptionLeaseKey {
  readonly userId: string;
  readonly chatId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export interface AcquireAdoptionLeaseInput extends ExternalAdoptionLease {}

/**
 * Takes the lease, or reports who holds it.
 *
 * The expired-row delete and the insert are one statement each rather than a
 * read-then-write: the primary key is what actually decides the race, and a
 * conflict is answered by reading the winner back instead of by trusting a row
 * that was read before the insert was attempted.
 */
export async function acquireAdoptionLease(
  input: AcquireAdoptionLeaseInput,
  db: Kysely<Database>
): Promise<{ readonly acquired: true } | { readonly acquired: false; readonly heldBy: string }> {
  await db
    .deleteFrom('external_session_adoption_leases')
    .where('environmentId', '=', input.environmentId)
    .where('targetId', '=', input.targetId)
    .where('nativeSessionId', '=', input.nativeSessionId)
    .where('expiresAt', '<=', input.acquiredAt)
    .execute();

  const inserted = await db
    .insertInto('external_session_adoption_leases')
    .values({
      environmentId: input.environmentId,
      targetId: input.targetId,
      nativeSessionId: input.nativeSessionId,
      userId: input.userId,
      chatId: input.chatId,
      acquiredAt: input.acquiredAt,
      expiresAt: input.expiresAt,
    })
    .onConflict((conflict) => conflict.doNothing())
    .executeTakeFirst();

  if ((inserted.numInsertedOrUpdatedRows ?? 0n) > 0n) return { acquired: true };

  const holder = await readAdoptionLease(input, db);
  // The holder vanished between the failed insert and this read — its chat was
  // deleted, or another request released it. Nothing is holding the session, so
  // the caller may try again rather than being told about a lease that is gone.
  return { acquired: false, heldBy: holder?.chatId ?? '' };
}

export async function readAdoptionLease(
  key: ExternalAdoptionLeaseKey,
  db: Kysely<Database>
): Promise<ExternalAdoptionLease | undefined> {
  const row = await db
    .selectFrom('external_session_adoption_leases')
    .selectAll()
    .where('environmentId', '=', key.environmentId)
    .where('targetId', '=', key.targetId)
    .where('nativeSessionId', '=', key.nativeSessionId)
    .executeTakeFirst();
  return row ?? undefined;
}

/**
 * Extends the chat's own lease, if it still has one.
 *
 * Scoped to the chat on purpose: a chat whose lease expired and was taken over
 * by somebody else must not silently reclaim it by continuing to send.
 */
export async function refreshAdoptionLease(
  chatId: string,
  expiresAt: number,
  db: Kysely<Database>
): Promise<void> {
  await db
    .updateTable('external_session_adoption_leases')
    .set({ expiresAt })
    .where('chatId', '=', chatId)
    .execute();
}

export async function releaseAdoptionLease(chatId: string, db: Kysely<Database>): Promise<void> {
  await db.deleteFrom('external_session_adoption_leases').where('chatId', '=', chatId).execute();
}
