import type { Migration } from 'kysely/migration';

export const chatAttachments: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('chat_attachments')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull().references('user.id').onDelete('cascade'))
      .addColumn('chatId', 'text', (col) =>
        col.notNull().references('chats.id').onDelete('cascade')
      )
      .addColumn('messageId', 'text', (col) => col.references('messages.id').onDelete('cascade'))
      .addColumn('originalName', 'text', (col) => col.notNull())
      .addColumn('storedName', 'text', (col) => col.notNull())
      .addColumn('relativePath', 'text', (col) => col.notNull())
      .addColumn('url', 'text', (col) => col.notNull())
      .addColumn('mimeType', 'text', (col) => col.notNull())
      .addColumn('sizeBytes', 'integer', (col) => col.notNull())
      .addColumn('kind', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_chat_attachments_user_chat')
      .ifNotExists()
      .on('chat_attachments')
      .columns(['userId', 'chatId'])
      .execute();

    await db.schema
      .createIndex('idx_chat_attachments_message')
      .ifNotExists()
      .on('chat_attachments')
      .columns(['messageId'])
      .execute();

    await db.schema
      .createIndex('idx_chat_attachments_unlinked')
      .ifNotExists()
      .on('chat_attachments')
      .columns(['userId', 'chatId', 'messageId'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_chat_attachments_user_chat').ifExists().execute();
    await db.schema.dropIndex('idx_chat_attachments_message').ifExists().execute();
    await db.schema.dropIndex('idx_chat_attachments_unlinked').ifExists().execute();
    await db.schema.dropTable('chat_attachments').ifExists().execute();
  },
};
