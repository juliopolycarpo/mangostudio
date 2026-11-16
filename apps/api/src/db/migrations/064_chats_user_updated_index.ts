import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Replaces the `(userId)` index on `chats` with `(userId, updatedAt DESC)`, so
 * the chat list reads one user's chats in the order it returns them. With
 * `userId` alone SQLite loaded every row of the user, blob columns included,
 * into a temp B-tree and sorted them.
 *
 * `updatedAt` is stored descending on purpose. SQLite appends `rowid` to every
 * index entry, so an ascending column read backwards would list chats that
 * share a millisecond in descending `rowid` order, while the sort it replaces
 * left them in ascending order. A descending column read forwards keeps the
 * order every client has seen. `userId` stays a prefix, so every owner lookup
 * (and the cascade from `user`) is still served, and the number of indexes on
 * `chats` is unchanged.
 */
export const chatsUserUpdatedIndex: Migration = {
  async up(db): Promise<void> {
    // The builder has no descending index column, so the statement is raw.
    await sql`CREATE INDEX IF NOT EXISTS idx_chats_user_id_updated_at ON chats (userId, updatedAt DESC)`.execute(
      db
    );
    await db.schema.dropIndex('chats_userId_idx').ifExists().execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .createIndex('chats_userId_idx')
      .ifNotExists()
      .on('chats')
      .column('userId')
      .execute();
    await db.schema.dropIndex('idx_chats_user_id_updated_at').ifExists().execute();
  },
};
