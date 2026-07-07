import type { Migration } from 'kysely/migration';

export const mcpServers: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('mcp_servers')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('slug', 'text', (col) => col.notNull())
      .addColumn('transport', 'text', (col) => col.notNull())
      .addColumn('command', 'text')
      .addColumn('argsJson', 'text', (col) => col.notNull())
      .addColumn('envJson', 'text', (col) => col.notNull())
      .addColumn('url', 'text')
      .addColumn('enabled', 'integer', (col) => col.notNull())
      .addColumn('timeoutMs', 'integer')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_mcp_servers_user')
      .ifNotExists()
      .on('mcp_servers')
      .column('userId')
      .execute();

    await db.schema
      .createIndex('idx_mcp_servers_user_slug')
      .ifNotExists()
      .on('mcp_servers')
      .columns(['userId', 'slug'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_mcp_servers_user_slug').ifExists().execute();
    await db.schema.dropIndex('idx_mcp_servers_user').ifExists().execute();
    await db.schema.dropTable('mcp_servers').ifExists().execute();
  },
};
