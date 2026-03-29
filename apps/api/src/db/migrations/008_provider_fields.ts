/**
 * Migration 008: adds provider fields to secret_metadata.
 * Adds nullable baseUrl column for custom provider endpoints.
 */

import type { Kysely } from 'kysely';

export const providerFields = {
  async up(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('secret_metadata').addColumn('baseUrl', 'text').execute();
  },

  async down(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('secret_metadata').dropColumn('baseUrl').execute();
  },
};
