import type { Migration } from 'kysely/migration';

/**
 * Indexes the two foreign keys on `messages.id` that no index could serve.
 *
 * Deleting a chat cascades through its messages, and SQLite looks up the child
 * rows of every deleted message by `messageId`. `file_checkpoints` only had
 * indexes that lead with `chatId`, and `message_uncheckpointed_sources` has
 * `messageId` second in its primary key, so each message scanned both tables
 * whole. On 200k messages, 50k checkpoint rows and 16k sources, deleting one
 * 100-message chat took about a second on the hub's only connection; with
 * both indexes it takes about two milliseconds.
 */
export const messageCascadeLookupIndexes: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_file_checkpoints_message')
      .ifNotExists()
      .on('file_checkpoints')
      .column('messageId')
      .execute();
    await db.schema
      .createIndex('idx_message_uncheckpointed_sources_message')
      .ifNotExists()
      .on('message_uncheckpointed_sources')
      .column('messageId')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_message_uncheckpointed_sources_message').ifExists().execute();
    await db.schema.dropIndex('idx_file_checkpoints_message').ifExists().execute();
  },
};
