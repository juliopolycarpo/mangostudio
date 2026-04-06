import { type Migration } from 'kysely';

/**
 * Migration 010 — add optional OpenAI auth-context columns to secret_metadata.
 *
 * organizationId and projectId are only meaningful for the official OpenAI
 * provider, but the columns are nullable and provider-agnostic so that the
 * persistence layer stays uniform across all connectors.
 */
export const openaiAuthContext: Migration = {
  async up(db) {
    await db.schema.alterTable('secret_metadata').addColumn('organizationId', 'text').execute();

    await db.schema.alterTable('secret_metadata').addColumn('projectId', 'text').execute();
  },

  async down(_db) {
    // SQLite does not support DROP COLUMN before version 3.35.0.
    // Dropping these columns is a no-op; the schema is append-only.
  },
};
