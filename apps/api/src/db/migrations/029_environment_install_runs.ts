import type { Migration } from 'kysely/migration';

export const environmentInstallRuns: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('environment_install_runs')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull().references('user.id').onDelete('cascade'))
      .addColumn('recipeId', 'text', (col) => col.notNull())
      .addColumn('argvJson', 'text', (col) => col.notNull())
      .addColumn('startedAt', 'integer', (col) => col.notNull())
      .addColumn('finishedAt', 'integer')
      .addColumn('exitCode', 'integer')
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('truncated', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_environment_install_runs_user_started')
      .ifNotExists()
      .on('environment_install_runs')
      .columns(['userId', 'startedAt'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_environment_install_runs_user_started').ifExists().execute();
    await db.schema.dropTable('environment_install_runs').ifExists().execute();
  },
};
