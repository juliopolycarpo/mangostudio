import type { Migration } from 'kysely/migration';

/**
 * Indexes the transcript read path and the attempt orphan scan.
 *
 * `messages(chatId, timestamp)` serves every `WHERE chatId = ? ORDER BY
 * timestamp` read (transcript pages, text and rich history). SQLite appends
 * the rowid to a secondary index, so the same index also yields the
 * `(timestamp, rowid)` order the transcript cursor pages by, with no sort step.
 * Before it, `idx_messages_chat_id` found a chat's rows but left SQLite to
 * sort them all through a temp B-tree on every page.
 *
 * `idx_messages_chat_id` is dropped in the same migration: it is a strict
 * prefix of the new index, so keeping it would only add write and size cost.
 * Every query that used it (the transcript reads, the `chatId = ? LIMIT 1`
 * existence probes, and the `chats` cascade lookup) is served by the new
 * index through its leading `chatId` column. `down` recreates it.
 *
 * `external_turn_attempts(state, messageId)` serves the boot orphan scan, which
 * filters on `state IN (...)` and joins `messages` on `messageId`; the index
 * covers both, so the scan no longer walks every attempt ever recorded. It is
 * a plain index, not a partial one over the open states: the app binds
 * `state IN (?, ?, ?)`, and SQLite does not match a partial index against bound
 * values, so it would scan the table and ignore it.
 *
 * Kysely's SQLite adapter has no transactional DDL, so the three statements
 * autocommit one at a time and the migration is not atomic. It is safe to rerun
 * after a crash between them because every statement is `IF NOT EXISTS` or
 * `IF EXISTS`, and a rerun finishes the rest.
 */
export const messagePagingIndexes: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_messages_chat_id_timestamp')
      .ifNotExists()
      .on('messages')
      .columns(['chatId', 'timestamp'])
      .execute();
    await db.schema
      .createIndex('external_turn_attempts_state')
      .ifNotExists()
      .on('external_turn_attempts')
      .columns(['state', 'messageId'])
      .execute();
    await db.schema.dropIndex('idx_messages_chat_id').ifExists().execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .createIndex('idx_messages_chat_id')
      .ifNotExists()
      .on('messages')
      .columns(['chatId'])
      .execute();
    await db.schema.dropIndex('external_turn_attempts_state').ifExists().execute();
    await db.schema.dropIndex('idx_messages_chat_id_timestamp').ifExists().execute();
  },
};
