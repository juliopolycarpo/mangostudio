import type { Migration } from 'kysely/migration';

/**
 * Records which environment a checkpoint's paths and hashes belong to. Reverting
 * resolves that stored target instead of the chat's current one, so a chat that
 * switches environments cannot replay old absolute paths onto a new host.
 * Existing rows predate per-chat targets, so they are Local by definition.
 */
export const fileCheckpointEnvironment: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('file_checkpoints')
      .addColumn('environmentId', 'text', (col) => col.notNull().defaultTo('local'))
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('file_checkpoints').dropColumn('environmentId').execute();
  },
};
