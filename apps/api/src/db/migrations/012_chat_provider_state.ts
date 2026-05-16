import type { Migration } from 'kysely/migration';

export const chatProviderState: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('chats').addColumn('lastProviderState', 'text').execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('chats').dropColumn('lastProviderState').execute();
  },
};
