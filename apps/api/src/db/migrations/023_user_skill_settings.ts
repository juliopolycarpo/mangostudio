import type { Migration } from 'kysely/migration';

export const userSkillSettings: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('user_skill_settings')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('skillKey', 'text', (col) => col.notNull())
      .addColumn('enabled', 'integer', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_user_skill_settings_user_skill')
      .ifNotExists()
      .on('user_skill_settings')
      .columns(['userId', 'skillKey'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_user_skill_settings_user_skill').ifExists().execute();
    await db.schema.dropTable('user_skill_settings').ifExists().execute();
  },
};
