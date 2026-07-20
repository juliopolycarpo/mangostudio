import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const chatRestrictToolsToWorkdir: Migration = {
  async up(db): Promise<void> {
    await sql`ALTER TABLE chats ADD COLUMN restrictToolsToWorkdir INTEGER`.execute(db);
  },

  async down(db): Promise<void> {
    await sql`ALTER TABLE chats DROP COLUMN restrictToolsToWorkdir`.execute(db);
  },
};
