/**
 * Migration 009: re-assigns existing openai-compatible connectors.
 * Connectors that have no baseUrl were implicitly using the official OpenAI
 * endpoint via the DEFAULT_BASE_URL fallback. Now that the fallback is
 * removed, those connectors must be re-assigned to the new 'openai' provider
 * type so they continue to work without any user action.
 */

import { type Migration } from 'kysely';

export const openaiProviderSplit: Migration = {
  async up(db) {
    await db
      .updateTable('secret_metadata')
      .set({ provider: 'openai' })
      .where('provider', '=', 'openai-compatible')
      .where((eb) => eb.or([eb('baseUrl', 'is', null), eb('baseUrl', '=', '')]))
      .execute();
  },

  async down(db) {
    await db
      .updateTable('secret_metadata')
      .set({ provider: 'openai-compatible' })
      .where('provider', '=', 'openai')
      .execute();
  },
};
