import { type Migration } from 'kysely';

export const chatProviderState: Migration = {
  async up(db) {
    await db.schema.alterTable('chats').addColumn('lastProviderState', 'text').execute();
  },

  async down(db) {
    await db.schema.alterTable('chats').dropColumn('lastProviderState').execute();
  },
};
