import type { Migration } from 'kysely/migration';

/**
 * Hub-side index of the backup sets library writes leave on each machine.
 *
 * Backups deliberately stay on the machine that owned the file, which makes
 * enumerating them by reading manifests a listing that only works for machines
 * the hub can reach right now. Without an index, an offline environment's
 * backups silently vanish from the page that promises them — the opposite of
 * what "restore needs that environment online" is supposed to communicate.
 *
 * This table says *that* a set exists; the manifest on the machine says *what*
 * is in it, and stays the only thing a restore ever reads. A row whose machine
 * lost its store degrades to an honest "unavailable" row rather than a restore
 * button that fails on click.
 */
export const libraryBackups: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('library_backups')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('environmentId', 'text', (col) => col.notNull())
      .addColumn('backupId', 'text', (col) => col.notNull())
      .addColumn('createdAtMs', 'integer', (col) => col.notNull())
      .addColumn('sizeBytes', 'integer', (col) => col.notNull())
      .addColumn('pinned', 'integer', (col) => col.notNull().defaultTo(0))
      // `propagation` | `removal` | `unknown`, mirroring the manifest field. Not
      // a foreign concept to the index: undo means opposite things either way,
      // and a row that cannot say which one it is has to say `unknown` rather
      // than guess.
      .addColumn('operation', 'text', (col) => col.notNull())
      .execute();

    // Backup ids are minted per store, so the same id can legitimately exist on
    // two machines. Identity is the triple, never the id alone.
    await db.schema
      .createIndex('idx_library_backups_identity')
      .ifNotExists()
      .on('library_backups')
      .columns(['userId', 'environmentId', 'backupId'])
      .unique()
      .execute();

    await db.schema
      .createIndex('idx_library_backups_user_created')
      .ifNotExists()
      .on('library_backups')
      .columns(['userId', 'createdAtMs'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_library_backups_user_created').ifExists().execute();
    await db.schema.dropIndex('idx_library_backups_identity').ifExists().execute();
    await db.schema.dropTable('library_backups').ifExists().execute();
  },
};
