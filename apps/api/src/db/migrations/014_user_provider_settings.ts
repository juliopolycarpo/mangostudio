import { type Migration } from 'kysely/migration';

export const userProviderSettings: Migration = {
  async up(db) {
    await db.schema
      .createTable('user_provider_settings')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('provider', 'text', (col) => col.notNull())
      .addColumn('settingsJson', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_user_provider_settings_user_provider')
      .ifNotExists()
      .on('user_provider_settings')
      .columns(['userId', 'provider'])
      .unique()
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex('idx_user_provider_settings_user_provider').ifExists().execute();
    await db.schema.dropTable('user_provider_settings').ifExists().execute();
  },
};
