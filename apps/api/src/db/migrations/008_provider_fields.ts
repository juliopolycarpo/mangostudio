/**
 * Migration 008: adds provider fields to secret_metadata.
 * Adds nullable baseUrl column for custom provider endpoints.
 */

import type { Migration } from 'kysely/migration';

export const providerFields: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('secret_metadata').addColumn('baseUrl', 'text').execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('secret_metadata').dropColumn('baseUrl').execute();
  },
};
