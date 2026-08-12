import type { Migration } from 'kysely/migration';

/**
 * Adopting a session the user started in a terminal.
 *
 * Two changes, because adoption needs both halves and neither is useful alone.
 *
 * **The lease.** A vendor session has one transcript, and two writers
 * interleave two conversations into it. The key is the session itself —
 * `(environmentId, targetId, nativeSessionId)` — rather than the chat, because
 * what must not happen twice is *attaching to that conversation*, whichever
 * chat is doing it. It expires so a hub that died holding one does not make the
 * session unadoptable forever, and it is refreshed while the chat is live so an
 * active conversation does not lose its claim to a stale timer.
 *
 * The lease deliberately cannot protect against a person typing into the same
 * session in their own terminal. Nothing in MangoStudio can see that. What it
 * does is make the half MangoStudio owns single-writer, and give adoption a
 * place to refuse rather than a race to lose.
 *
 * **`pendingAdoption`.** An ordinary turn resumes with `resumeMode: 'fallback'`
 * — a vendor that forgot the session gets a fresh one, which is right for a
 * send. Adoption is the opposite case: the user picked *that* conversation by
 * name, and silently handing them an empty one is the failure the strict mode
 * exists to prevent. The flag marks the continuation row whose first open must
 * be strict, and is cleared once the vendor has actually resumed it.
 */
export const externalSessionAdoption: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('external_session_continuations')
      .addColumn('pendingAdoption', 'integer', (col) => col.notNull().defaultTo(0))
      .execute();

    await db.schema
      .createTable('external_session_adoption_leases')
      .ifNotExists()
      .addColumn('environmentId', 'text', (col) => col.notNull())
      .addColumn('targetId', 'text', (col) => col.notNull())
      .addColumn('nativeSessionId', 'text', (col) => col.notNull())
      .addColumn('userId', 'text', (col) => col.notNull())
      /** Cascades on chat deletion: a chat that is gone holds nothing. */
      .addColumn('chatId', 'text', (col) =>
        col.notNull().references('chats.id').onDelete('cascade')
      )
      .addColumn('acquiredAt', 'integer', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('external_session_adoption_leases_pk', [
        'environmentId',
        'targetId',
        'nativeSessionId',
      ])
      .execute();

    // One chat holds at most one lease, so releasing by chat id is a point
    // lookup rather than a scan of every held session on the hub.
    await db.schema
      .createIndex('external_session_adoption_leases_chat')
      .ifNotExists()
      .on('external_session_adoption_leases')
      .column('chatId')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('external_session_adoption_leases').ifExists().execute();
    await db.schema
      .alterTable('external_session_continuations')
      .dropColumn('pendingAdoption')
      .execute();
  },
};
