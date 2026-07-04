import type { Migration } from 'kysely/migration';

export const connectorUsageSamples: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('connector_usage_samples')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('accountId', 'text', (col) => col.notNull())
      .addColumn('window', 'text', (col) => col.notNull())
      .addColumn('usedPercent', 'real', (col) => col.notNull())
      .addColumn('windowMinutes', 'real')
      .addColumn('resetsAt', 'integer')
      .addColumn('sampledAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_connector_usage_samples_series')
      .ifNotExists()
      .on('connector_usage_samples')
      .columns(['accountId', 'window', 'sampledAt'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_connector_usage_samples_series').ifExists().execute();
    await db.schema.dropTable('connector_usage_samples').ifExists().execute();
  },
};
