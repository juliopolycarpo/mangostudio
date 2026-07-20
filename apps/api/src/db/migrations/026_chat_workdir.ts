import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const chatWorkdir: Migration = {
  async up(db): Promise<void> {
    await sql`ALTER TABLE chats ADD COLUMN workdir TEXT`.execute(db);
  },

  async down(db): Promise<void> {
    await sql`ALTER TABLE chats DROP COLUMN workdir`.execute(db);
  },
};
