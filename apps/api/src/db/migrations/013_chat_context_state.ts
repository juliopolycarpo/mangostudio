import type { Migration } from 'kysely/migration';

export const chatContextState: Migration = {
  async up(db) {
    await db.schema.alterTable('chats').addColumn('lastContextState', 'text').execute();
  },

  async down(db) {
    await db.schema.alterTable('chats').dropColumn('lastContextState').execute();
  },
};
