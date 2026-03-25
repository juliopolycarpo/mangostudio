/**
 * Migration 004: adds performance indexes for common queries.
 */

import type { Kysely } from 'kysely';

export const addIndexes = {
  async up(db: Kysely<any>): Promise<void> {
    // Index for gallery query: role='ai', imageUrl not null, ordered by timestamp
    await db.schema
      .createIndex('idx_messages_role_image_url_timestamp')
      .ifNotExists()
      .on('messages')
      .columns(['role', 'imageUrl', 'timestamp'])
      .execute();

    // Index for subquery: find user messages by chatId, role, timestamp
    await db.schema
      .createIndex('idx_messages_chat_id_role_timestamp')
      .ifNotExists()
      .on('messages')
      .columns(['chatId', 'role', 'timestamp'])
      .execute();

    // Index for chat-specific queries (e.g., loading chat messages)
    await db.schema
      .createIndex('idx_messages_chat_id')
      .ifNotExists()
      .on('messages')
      .columns(['chatId'])
      .execute();

    // Index for ordering chats by updatedAt (chat list)
    await db.schema
      .createIndex('idx_chats_updated_at')
      .ifNotExists()
      .on('chats')
      .columns(['updatedAt'])
      .execute();
  },

  async down(db: Kysely<any>): Promise<void> {
    await db.schema.dropIndex('idx_messages_role_image_url_timestamp').ifExists().execute();
    await db.schema.dropIndex('idx_messages_chat_id_role_timestamp').ifExists().execute();
    await db.schema.dropIndex('idx_messages_chat_id').ifExists().execute();
    await db.schema.dropIndex('idx_chats_updated_at').ifExists().execute();
  },
};
