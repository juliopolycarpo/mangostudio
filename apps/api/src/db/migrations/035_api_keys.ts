import type { Migration } from 'kysely/migration';

// Table shape dictated by the @better-auth/api-key plugin's own schema.
// Better Auth's kysely adapter reports supportsDates: false for sqlite, so
// the date columns below (lastRefillAt, lastRequest, expiresAt, createdAt,
// updatedAt) are written as ISO strings at runtime, not integers, despite
// SQLite type affinity accepting either. Do not "correct" these to
// `integer` — see the same finding recorded against 006_auth_tables.ts.
export const apiKeys: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('apikey')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('configId', 'text', (col) => col.notNull())
      .addColumn('name', 'text')
      .addColumn('start', 'text')
      .addColumn('referenceId', 'text', (col) =>
        col.notNull().references('user.id').onDelete('cascade')
      )
      .addColumn('prefix', 'text')
      .addColumn('key', 'text', (col) => col.notNull())
      .addColumn('refillInterval', 'integer')
      .addColumn('refillAmount', 'integer')
      .addColumn('lastRefillAt', 'text')
      .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('rateLimitEnabled', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('rateLimitTimeWindow', 'integer')
      .addColumn('rateLimitMax', 'integer')
      .addColumn('requestCount', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('remaining', 'integer')
      .addColumn('lastRequest', 'text')
      .addColumn('expiresAt', 'text')
      .addColumn('createdAt', 'text', (col) => col.notNull())
      .addColumn('updatedAt', 'text', (col) => col.notNull())
      .addColumn('permissions', 'text')
      .addColumn('metadata', 'text')
      .execute();

    await db.schema
      .createIndex('apikey_referenceId_idx')
      .on('apikey')
      .column('referenceId')
      .execute();

    await db.schema.createIndex('apikey_key_idx').on('apikey').column('key').execute();

    await db.schema.createIndex('apikey_configId_idx').on('apikey').column('configId').execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('apikey_configId_idx').ifExists().execute();
    await db.schema.dropIndex('apikey_key_idx').ifExists().execute();
    await db.schema.dropIndex('apikey_referenceId_idx').ifExists().execute();
    await db.schema.dropTable('apikey').ifExists().execute();
  },
};
