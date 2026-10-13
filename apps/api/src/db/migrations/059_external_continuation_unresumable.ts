import type { Migration } from 'kysely/migration';

/**
 * Marks a stored vendor conversation that must not be resumed.
 *
 * The Claude CLI documents that resuming a session "continues the turn that SIGTERM left
 * unfinished". The External Agents SDK refuses further turns on a session whose child it had to
 * kill, but that taint lives in the runtime session's memory: once the session is gone (a dropped
 * connection, a runtime or hub restart) a strict resume of the stored conversation would carry on
 * the work the user stopped. The hub therefore records, on the continuation row itself, that the
 * conversation's last turn ended in a way that may have killed the child. The next open of a
 * marked row starts a new conversation and says so; a turn that completes on the same native
 * session clears the mark, since the SDK would have refused it on a killed one.
 */
export const externalContinuationUnresumable: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('external_session_continuations')
      .addColumn('unresumable', 'integer', (col) => col.notNull().defaultTo(0))
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .alterTable('external_session_continuations')
      .dropColumn('unresumable')
      .execute();
  },
};
