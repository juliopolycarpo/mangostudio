import type { Migration } from 'kysely/migration';

export const chatTodos: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('chat_todos')
      .ifNotExists()
      .addColumn('chatId', 'text', (col) =>
        col.primaryKey().references('chats.id').onDelete('cascade')
      )
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('items', 'text', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_chat_todos_user')
      .ifNotExists()
      .on('chat_todos')
      .column('userId')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_chat_todos_user').ifExists().execute();
    await db.schema.dropTable('chat_todos').ifExists().execute();
  },
};
