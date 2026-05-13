import { sql } from 'kysely';
import { type Migration } from 'kysely/migration';

export const chatAgentSelection: Migration = {
  async up(db) {
    await sql`ALTER TABLE chats ADD COLUMN selectedAgentId TEXT`.execute(db);
  },

  async down(db) {
    await sql`ALTER TABLE chats DROP COLUMN selectedAgentId`.execute(db);
  },
};
