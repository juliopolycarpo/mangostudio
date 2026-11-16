import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Replaces two messages indexes with ones that hold the order their reads ask
 * for, so SQLite walks the index and stops at the limit instead of loading
 * every candidate row and sorting it in a temp B-tree.
 *
 * - `(chatId, timestamp)` replaces `(chatId)`. A transcript page and both
 *   history reads take one chat in `timestamp, rowid` order with a limit; with
 *   `chatId` alone a page of 50 read and sorted the whole chat, `text` and
 *   `parts` overflow pages included. SQLite appends `rowid` to every index, so
 *   the new one carries the full `(timestamp, rowid)` order. `(chatId)` was
 *   already a prefix of `(chatId, role, timestamp)`, and every `chatId` lookup
 *   (and the cascade from `chats`) is still served by either index.
 * - `(role, timestamp) WHERE imageUrl IS NOT NULL` replaces
 *   `(role, imageUrl, timestamp)`. The gallery reads `ai` image rows newest
 *   first; the old index ranged over `imageUrl`, so it could not supply
 *   `timestamp` order and the rows that passed the account and artifact
 *   filters were sorted for every page. With the order from the index a page
 *   stops at its limit. Image turns that also have a `generated_images` row
 *   are filtered out, so where every image row has one, both plans still
 *   visit every image row; the page gets cheaper only with legacy rows. Only
 *   image rows enter the partial index, so a text message insert no longer
 *   maintains it. The predicate stays a literal, as SQLite requires.
 *
 * The number of indexes on `messages` is unchanged.
 */
export const messagesOrderedReadIndexes: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_messages_chat_id_timestamp')
      .ifNotExists()
      .on('messages')
      .columns(['chatId', 'timestamp'])
      .execute();
    await db.schema.dropIndex('idx_messages_chat_id').ifExists().execute();

    await db.schema
      .createIndex('idx_messages_role_timestamp_image')
      .ifNotExists()
      .on('messages')
      .columns(['role', 'timestamp'])
      // The builder only types the indexed columns, so the filter column is a raw ref.
      .where(sql.ref('imageUrl'), 'is not', null)
      .execute();
    await db.schema.dropIndex('idx_messages_role_image_url_timestamp').ifExists().execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .createIndex('idx_messages_role_image_url_timestamp')
      .ifNotExists()
      .on('messages')
      .columns(['role', 'imageUrl', 'timestamp'])
      .execute();
    await db.schema.dropIndex('idx_messages_role_timestamp_image').ifExists().execute();

    await db.schema
      .createIndex('idx_messages_chat_id')
      .ifNotExists()
      .on('messages')
      .column('chatId')
      .execute();
    await db.schema.dropIndex('idx_messages_chat_id_timestamp').ifExists().execute();
  },
};
