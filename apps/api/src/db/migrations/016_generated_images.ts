import type { Migration } from 'kysely/migration';

export const generatedImages: Migration = {
  async up(db) {
    await db.schema
      .createTable('generated_images')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull().references('user.id').onDelete('cascade'))
      .addColumn('chatId', 'text', (col) =>
        col.notNull().references('chats.id').onDelete('cascade')
      )
      .addColumn('messageId', 'text', (col) =>
        col.notNull().references('messages.id').onDelete('cascade')
      )
      .addColumn('toolCallId', 'text')
      .addColumn('prompt', 'text', (col) => col.notNull())
      .addColumn('imageUrl', 'text', (col) => col.notNull())
      .addColumn('modelName', 'text')
      .addColumn('generationTime', 'text')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('metadataJson', 'text')
      .execute();

    await db.schema
      .createIndex('idx_generated_images_user_created_at')
      .ifNotExists()
      .on('generated_images')
      .columns(['userId', 'createdAt'])
      .execute();

    await db.schema
      .createIndex('idx_generated_images_chat_created_at')
      .ifNotExists()
      .on('generated_images')
      .columns(['chatId', 'createdAt'])
      .execute();

    await db.schema
      .createIndex('idx_generated_images_message_id')
      .ifNotExists()
      .on('generated_images')
      .columns(['messageId'])
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex('idx_generated_images_user_created_at').ifExists().execute();
    await db.schema.dropIndex('idx_generated_images_chat_created_at').ifExists().execute();
    await db.schema.dropIndex('idx_generated_images_message_id').ifExists().execute();
    await db.schema.dropTable('generated_images').ifExists().execute();
  },
};
