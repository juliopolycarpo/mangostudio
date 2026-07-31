import type { Migration } from 'kysely/migration';

export const environmentEntities: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('environments')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.notNull())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('transportKind', 'text', (col) => col.notNull())
      .addColumn('configJson', 'text', (col) => col.notNull())
      .addColumn('enabled', 'integer', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_environments', ['userId', 'id'])
      .execute();

    await db.schema
      .createIndex('idx_environments_user')
      .ifNotExists()
      .on('environments')
      .column('userId')
      .execute();

    await db.schema
      .alterTable('chats')
      .addColumn('environmentId', 'text', (col) => col.notNull().defaultTo('local'))
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('chats').dropColumn('environmentId').execute();
    await db.schema.dropIndex('idx_environments_user').ifExists().execute();
    await db.schema.dropTable('environments').ifExists().execute();
  },
};
