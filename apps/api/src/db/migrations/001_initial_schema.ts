/**
 * Initial schema migration: creates chats and messages tables.
 * Matches the existing SQLite schema from the prototype.
 */

import { type Migration } from 'kysely';

export const initialSchema: Migration = {
  async up(db) {
    await db.schema
      .createTable('chats')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .addColumn('model', 'text')
      .execute();

    await db.schema
      .createTable('messages')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('chatId', 'text', (col) =>
        col.notNull().references('chats.id').onDelete('cascade')
      )
      .addColumn('role', 'text', (col) => col.notNull())
      .addColumn('text', 'text', (col) => col.notNull())
      .addColumn('imageUrl', 'text')
      .addColumn('referenceImage', 'text')
      .addColumn('timestamp', 'integer', (col) => col.notNull())
      .addColumn('isGenerating', 'integer', (col) => col.defaultTo(0))
      .addColumn('generationTime', 'text')
      .addColumn('modelName', 'text')
      .addColumn('styleParams', 'text')
      .execute();
  },

  async down(db) {
    await db.schema.dropTable('messages').execute();
    await db.schema.dropTable('chats').execute();
  },
};
