import type { Migration } from 'kysely/migration';

/**
 * What a turn wrote that no checkpoint describes.
 *
 * `file_checkpoints` records one row per path a builtin mutator touched. Shell
 * and MCP tools have no path list to snapshot, so their writes leave no row at
 * all — and revert reported a plain file count over that silence, telling the
 * user a turn was undone when part of it was not.
 *
 * Its own table rather than a column, for two reasons. A column on
 * `file_checkpoints` only exists once a builtin mutator has also run, so a turn
 * that only ran `bash` would record nothing; and a set-valued column on
 * `messages` is a read-modify-write, which the tool calls of one turn perform
 * concurrently — two parallel sources would race and one would be lost. A row
 * per source makes recording an idempotent insert with no read.
 *
 * `source` is the class of tool, not the tool name: the copy this drives speaks
 * about shell commands and MCP tools, and a per-name list would leak tool
 * identifiers into the UI while growing without bound.
 */
export const messageUncheckpointedSources: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('message_uncheckpointed_sources')
      .ifNotExists()
      .addColumn('chatId', 'text', (col) =>
        col.notNull().references('chats.id').onDelete('cascade')
      )
      .addColumn('messageId', 'text', (col) =>
        col.notNull().references('messages.id').onDelete('cascade')
      )
      /** `shell` | `mcp` — see `UncheckpointedWriteSourceSchema`. */
      .addColumn('source', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      // The primary key is the whole row's identity, which is what makes
      // recording a source a conflict-free repeat rather than a duplicate.
      .addPrimaryKeyConstraint('message_uncheckpointed_sources_pk', [
        'chatId',
        'messageId',
        'source',
      ])
      .execute();

    // The checkpoint list reads every uncheckpointed source of a chat in one
    // query, alongside the manifest rows it qualifies.
    await db.schema
      .createIndex('idx_message_uncheckpointed_sources_chat')
      .ifNotExists()
      .on('message_uncheckpointed_sources')
      .column('chatId')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_message_uncheckpointed_sources_chat').ifExists().execute();
    await db.schema.dropTable('message_uncheckpointed_sources').ifExists().execute();
  },
};
