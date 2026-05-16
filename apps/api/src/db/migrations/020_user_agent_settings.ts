import type { Migration } from 'kysely/migration';

export const userAgentSettings: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('user_agent_settings')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('agentId', 'text', (col) => col.notNull())
      .addColumn('settingsJson', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_user_agent_settings_user_agent')
      .ifNotExists()
      .on('user_agent_settings')
      .columns(['userId', 'agentId'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_user_agent_settings_user_agent').ifExists().execute();
    await db.schema.dropTable('user_agent_settings').ifExists().execute();
  },
};
