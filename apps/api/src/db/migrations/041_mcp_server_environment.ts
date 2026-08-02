import type { Migration } from 'kysely/migration';

/**
 * Binds each MCP server to the environment that hosts its session. A stdio
 * server's command and an HTTP server's URL are only meaningful on one
 * machine, so the row has to say which. Existing rows predate per-environment
 * hosting and ran in the hub process, so they are Local by definition.
 */
export const mcpServerEnvironment: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('mcp_servers')
      .addColumn('environmentId', 'text', (col) => col.notNull().defaultTo('local'))
      .execute();

    // Turn resolution reads every enabled server of one user on one
    // environment; without this it scans the user's whole set per turn.
    await db.schema
      .createIndex('idx_mcp_servers_user_environment')
      .ifNotExists()
      .on('mcp_servers')
      .columns(['userId', 'environmentId'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_mcp_servers_user_environment').ifExists().execute();
    await db.schema.alterTable('mcp_servers').dropColumn('environmentId').execute();
  },
};
