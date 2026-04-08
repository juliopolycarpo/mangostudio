/**
 * Migration 005: adds support for multiple connectors and enabled models list.
 */

import { type Migration } from 'kysely';

export const multiConnectors: Migration = {
  async up(db) {
    // 1. Drop old table
    await db.schema.dropTable('secret_metadata').ifExists().execute();

    // 2. Create new table with support for multiple connectors
    await db.schema
      .createTable('secret_metadata')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('provider', 'text', (col) => col.notNull())
      .addColumn('configured', 'integer', (col) => col.notNull())
      .addColumn('source', 'text', (col) => col.notNull())
      .addColumn('maskedSuffix', 'text')
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .addColumn('lastValidatedAt', 'integer')
      .addColumn('lastValidationError', 'text')
      .addColumn('enabledModels', 'text', (col) => col.notNull())
      .execute();
  },

  async down(db) {
    // Reverting to the old schema if necessary (provider as PK)
    await db.schema.dropTable('secret_metadata').ifExists().execute();
    await db.schema
      .createTable('secret_metadata')
      .ifNotExists()
      .addColumn('provider', 'text', (col) => col.primaryKey())
      .addColumn('configured', 'integer', (col) => col.notNull())
      .addColumn('source', 'text', (col) => col.notNull())
      .addColumn('maskedSuffix', 'text')
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .addColumn('lastValidatedAt', 'integer')
      .addColumn('lastValidationError', 'text')
      .execute();
  },
};
