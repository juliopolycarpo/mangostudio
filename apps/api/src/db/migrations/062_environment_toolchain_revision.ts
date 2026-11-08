import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Gives each saved environment a revision against which toolchain paths can be validated. */
export const environmentToolchainRevision: Migration = {
  async up(db): Promise<void> {
    // SQLite can commit the ALTER before Kysely records the migration.
    const columns = await sql<{ name: string }>`PRAGMA table_info(environments)`.execute(db);
    if (!columns.rows.some(({ name }) => name === 'toolchainRevision')) {
      await db.schema
        .alterTable('environments')
        .addColumn('toolchainRevision', 'text', (column) => column.notNull().defaultTo(''))
        .execute();
    }
    await db
      .updateTable('environments')
      .set({ toolchainRevision: sql`lower(hex(randomblob(16)))` })
      .where('toolchainRevision', '=', '')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('environments').dropColumn('toolchainRevision').execute();
  },
};
