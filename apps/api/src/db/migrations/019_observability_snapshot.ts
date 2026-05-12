import { type Migration } from 'kysely/migration';

export const observabilitySnapshot: Migration = {
  async up(db) {
    await db.schema
      .createTable('observability_snapshot')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('snapshotJson', 'text', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable('observability_snapshot').ifExists().execute();
  },
};
