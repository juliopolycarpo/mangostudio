import type { Migration } from 'kysely/migration';

export const activityEvents: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('activity_events')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('kind', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('chatId', 'text')
      .addColumn('workdir', 'text')
      .addColumn('environmentId', 'text')
      .addColumn('targetId', 'text')
      .addColumn('payloadJson', 'text', (col) => col.notNull())
      .execute();

    // The feed reads newest-first per user; the tie-break on `id` keeps the keyset
    // cursor total when two events share a millisecond.
    await db.schema
      .createIndex('idx_activity_events_user_created')
      .ifNotExists()
      .on('activity_events')
      .columns(['userId', 'createdAt', 'id'])
      .execute();

    await db.schema
      .createIndex('idx_activity_events_user_workdir_created')
      .ifNotExists()
      .on('activity_events')
      .columns(['userId', 'workdir', 'createdAt', 'id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_activity_events_user_workdir_created').ifExists().execute();
    await db.schema.dropIndex('idx_activity_events_user_created').ifExists().execute();
    await db.schema.dropTable('activity_events').ifExists().execute();
  },
};
