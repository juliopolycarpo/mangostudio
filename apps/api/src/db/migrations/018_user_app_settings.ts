import type { Migration } from 'kysely/migration';

export const userAppSettings: Migration = {
  async up(db) {
    await db.schema
      .createTable('user_app_settings')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('settingsJson', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_user_app_settings_user')
      .ifNotExists()
      .on('user_app_settings')
      .column('userId')
      .unique()
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex('idx_user_app_settings_user').ifExists().execute();
    await db.schema.dropTable('user_app_settings').ifExists().execute();
  },
};
