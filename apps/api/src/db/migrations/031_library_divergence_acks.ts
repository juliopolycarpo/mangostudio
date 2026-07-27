import type { Migration } from 'kysely/migration';

export const libraryDivergenceAcks: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('library_divergence_acks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('resourceKey', 'text', (col) => col.notNull())
      // Digest of the exact hash set the user accepted. Editing any copy moves
      // this value, which is what makes an acknowledgement expire on its own.
      .addColumn('divergenceKey', 'text', (col) => col.notNull())
      .addColumn('contentHashesJson', 'text', (col) => col.notNull())
      .addColumn('acknowledgedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_library_divergence_acks_user_resource')
      .ifNotExists()
      .on('library_divergence_acks')
      .columns(['userId', 'resourceKey'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_library_divergence_acks_user_resource').ifExists().execute();
    await db.schema.dropTable('library_divergence_acks').ifExists().execute();
  },
};
