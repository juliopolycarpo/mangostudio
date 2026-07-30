import type { Migration } from 'kysely/migration';

/**
 * Migration 036 — user-defined names and monograms for tools.
 *
 * A row exists only for a subject the user actually customized; everything
 * else resolves to a derived default, so an untouched install stores nothing.
 * `displayName` and `monogram` are independently nullable for the same reason:
 * clearing one falls back to its default rather than deleting the row.
 */
export const userToolIdentities: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('user_tool_identities')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      // Reserved profile scope; always `default` until profiles ship (032).
      .addColumn('profileId', 'text', (col) => col.notNull().defaultTo('default'))
      // `<kind>:<id>` — the wire id the label hangs on, which never renames.
      .addColumn('subjectKey', 'text', (col) => col.notNull())
      .addColumn('displayName', 'text')
      .addColumn('monogram', 'text')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_user_tool_identities_user_profile_subject')
      .ifNotExists()
      .on('user_tool_identities')
      .columns(['userId', 'profileId', 'subjectKey'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_user_tool_identities_user_profile_subject').ifExists().execute();
    await db.schema.dropTable('user_tool_identities').ifExists().execute();
  },
};
