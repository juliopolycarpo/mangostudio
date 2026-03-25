/**
 * Migration 003: adds secret metadata storage for provider-backed settings.
 * Raw secrets stay in Bun.secrets; SQLite stores only UI-safe metadata.
 */

import type { Kysely } from 'kysely';

export const addSecretMetadata = {
  async up(db: Kysely<any>): Promise<void> {
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

  async down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('secret_metadata').ifExists().execute();
  },
};
