import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Replaces the `(userId)` index on `chats` with `(userId, updatedAt DESC)`, so
 * the chat list reads one user's chats in the order it returns them. With
 * `userId` alone SQLite loaded every row of the user, blob columns included,
 * into a temp B-tree and sorted them.
 *
 * `updatedAt` is stored descending on purpose. The list asks for
 * `updatedAt DESC, rowid ASC`, and SQLite appends `rowid` to every index
 * entry, so a descending column read forwards supplies both keys. An ascending
 * column read backwards would give `rowid DESC` for chats that share a
 * millisecond and bring the sort back. `userId` stays a prefix, so every owner
 * lookup (and the cascade from `user`) is still served.
 *
 * It also drops `idx_chats_updated_at` (`updatedAt` alone), which 004 added
 * for the chat list. No read uses it: the list has its own index now, and the
 * recency writes (`updateChatAfterTurn`, the image turn, `createMessage`)
 * filter on `id`, which the primary key serves. Every recency write would
 * otherwise maintain two indexes that hold `updatedAt`. `chats` ends up with
 * one secondary index, where it had two.
 */
export const chatsUserUpdatedIndex: Migration = {
  async up(db): Promise<void> {
    // The builder has no descending index column, so the statement is raw.
    await sql`CREATE INDEX IF NOT EXISTS idx_chats_user_id_updated_at ON chats (userId, updatedAt DESC)`.execute(
      db
    );
    await db.schema.dropIndex('chats_userId_idx').ifExists().execute();
    await db.schema.dropIndex('idx_chats_updated_at').ifExists().execute();
  },

  async down(db): Promise<void> {
    // As 004 created it.
    await db.schema
      .createIndex('idx_chats_updated_at')
      .ifNotExists()
      .on('chats')
      .columns(['updatedAt'])
      .execute();
    await db.schema
      .createIndex('chats_userId_idx')
      .ifNotExists()
      .on('chats')
      .column('userId')
      .execute();
    await db.schema.dropIndex('idx_chats_user_id_updated_at').ifExists().execute();
  },
};
