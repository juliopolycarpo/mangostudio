import type { Migration } from 'kysely/migration';

export const fileCheckpoints: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('file_checkpoints')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('chatId', 'text', (col) =>
        col.notNull().references('chats.id').onDelete('cascade')
      )
      .addColumn('messageId', 'text', (col) =>
        col.notNull().references('messages.id').onDelete('cascade')
      )
      .addColumn('path', 'text', (col) => col.notNull())
      .addColumn('op', 'text', (col) => col.notNull())
      .addColumn('beforeHash', 'text')
      .addColumn('afterHash', 'text')
      .addColumn('movedTo', 'text')
      .addColumn('blobKey', 'text')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('revertedAt', 'integer')
      .execute();

    await db.schema
      .createIndex('idx_file_checkpoints_chat_message')
      .ifNotExists()
      .on('file_checkpoints')
      .columns(['chatId', 'messageId'])
      .execute();

    await db.schema
      .createIndex('idx_file_checkpoints_chat_created')
      .ifNotExists()
      .on('file_checkpoints')
      .columns(['chatId', 'createdAt'])
      .execute();

    await db.schema
      .createIndex('idx_file_checkpoints_unique_path')
      .ifNotExists()
      .on('file_checkpoints')
      .columns(['chatId', 'messageId', 'path'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_file_checkpoints_unique_path').ifExists().execute();
    await db.schema.dropIndex('idx_file_checkpoints_chat_created').ifExists().execute();
    await db.schema.dropIndex('idx_file_checkpoints_chat_message').ifExists().execute();
    await db.schema.dropTable('file_checkpoints').ifExists().execute();
  },
};
