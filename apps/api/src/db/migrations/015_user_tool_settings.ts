import { type Migration } from 'kysely/migration';

export const userToolSettings: Migration = {
  async up(db) {
    await db.schema
      .createTable('user_tool_settings')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('toolName', 'text', (col) => col.notNull())
      .addColumn('enabled', 'integer', (col) => col.notNull())
      .addColumn('parametersJson', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_user_tool_settings_user_tool')
      .ifNotExists()
      .on('user_tool_settings')
      .columns(['userId', 'toolName'])
      .unique()
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex('idx_user_tool_settings_user_tool').ifExists().execute();
    await db.schema.dropTable('user_tool_settings').ifExists().execute();
  },
};
