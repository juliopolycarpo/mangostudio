import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Holds what a streaming turn adds to its assistant row between full rewrites.
 *
 * A turn used to rewrite the whole `messages` row at every checkpoint, so the
 * bytes written grew with the square of the turn: each checkpoint carried the
 * answer so far and every tool result so far. A checkpoint now inserts one row
 * here with only what changed since the previous one (appended text, a
 * finished tool result, a part whose state moved), and a reader folds the rows
 * over the `messages` row to get the same message the rewrite would have
 * stored.
 *
 * Rows exist only while the message is generating. The trigger removes them
 * when the message stops generating, whichever writer ends it (the finalizers,
 * crash reconciliation, the PATCH route), so no caller has to remember to.
 * Deleting a message removes them through the foreign key.
 *
 * `WITHOUT ROWID` keeps each row in the primary-key B-tree, so a small
 * checkpoint dirties one page instead of a table page and an index page.
 */
export const messageCheckpointDeltas: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('message_checkpoint_deltas')
      .ifNotExists()
      .addColumn('messageId', 'text', (col) =>
        col.notNull().references('messages.id').onDelete('cascade')
      )
      // Order of application; the writer counts up from 1.
      .addColumn('seq', 'integer', (col) => col.notNull())
      // JSON-serialized CheckpointDelta.
      .addColumn('delta', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_message_checkpoint_deltas', ['messageId', 'seq'])
      .modifyEnd(sql`without rowid`)
      .execute();

    await sql`
      CREATE TRIGGER IF NOT EXISTS trg_message_checkpoint_deltas_cleanup
      AFTER UPDATE OF isGenerating ON messages
      WHEN OLD.isGenerating = 1 AND NEW.isGenerating = 0
      BEGIN
        DELETE FROM message_checkpoint_deltas WHERE messageId = NEW.id;
      END
    `.execute(db);
  },

  async down(db): Promise<void> {
    await sql`DROP TRIGGER IF EXISTS trg_message_checkpoint_deltas_cleanup`.execute(db);
    await db.schema.dropTable('message_checkpoint_deltas').ifExists().execute();
  },
};
