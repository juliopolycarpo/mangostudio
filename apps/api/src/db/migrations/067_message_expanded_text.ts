import type { Migration } from 'kysely/migration';

/**
 * Migration 067 adds `messages.expandedText`, the prompt a model was actually
 * sent for a user message whose typed text was a slash command.
 *
 * `text` stays what the user typed, because that is what the transcript shows.
 * A native `/review a.ts` is expanded from the user's command file before the
 * turn runs, so replaying `text` in a later turn would hand the model a command
 * name in place of the instructions it acted on. History reads
 * `COALESCE(expandedText, text)`.
 *
 * Nullable with no default: every existing row, and every message that was not
 * a command, replays exactly as it did before. The column is never returned to
 * clients.
 */
export const messageExpandedText: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('messages')
      .addColumn('expandedText', 'text', (col) => col.defaultTo(null))
      .execute();
  },

  async down(_db): Promise<void> {
    // SQLite cannot drop a column portably; the schema is append-only.
  },
};
