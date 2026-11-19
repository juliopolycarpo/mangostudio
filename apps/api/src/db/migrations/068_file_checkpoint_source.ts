import type { Migration } from 'kysely/migration';

/**
 * Records where a checkpoint row came from: `builtin` for a mutator that
 * snapshotted one path under its lock, `shell` for a row found by comparing the
 * workspace before and after an opted-in shell command.
 *
 * The two differ in what a revert can promise. A builtin row holds exactly what
 * that call changed; a shell row holds whatever changed on disk during the
 * command, including a write by another process. The revert preview reads this
 * column to say so only for turns that have such rows. Existing rows predate
 * shell capture, so they are `builtin` by definition.
 */
export const fileCheckpointSource: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('file_checkpoints')
      .addColumn('source', 'text', (col) => col.notNull().defaultTo('builtin'))
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('file_checkpoints').dropColumn('source').execute();
  },
};
