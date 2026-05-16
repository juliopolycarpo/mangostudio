import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const chatAgentSelection: Migration = {
  async up(db): Promise<void> {
    await sql`ALTER TABLE chats ADD COLUMN selectedAgentId TEXT`.execute(db);
  },

  async down(db): Promise<void> {
    await sql`ALTER TABLE chats DROP COLUMN selectedAgentId`.execute(db);
  },
};
