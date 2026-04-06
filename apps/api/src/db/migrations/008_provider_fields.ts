/**
 * Migration 008: adds provider fields to secret_metadata.
 * Adds nullable baseUrl column for custom provider endpoints.
 */

import { type Migration } from 'kysely';

export const providerFields: Migration = {
  async up(db) {
    await db.schema.alterTable('secret_metadata').addColumn('baseUrl', 'text').execute();
  },

  async down(db) {
    await db.schema.alterTable('secret_metadata').dropColumn('baseUrl').execute();
  },
};
