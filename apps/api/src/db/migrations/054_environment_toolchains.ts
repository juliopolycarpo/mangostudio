import type { Migration } from 'kysely/migration';

/**
 * Which Node and Bun every process spawned on one environment runs with.
 *
 * The primary key is `(userId, environmentId)`. No foreign key on
 * `environmentId`: the Local environment is virtual (`LOCAL_ENVIRONMENT_ID`)
 * and never has a row in `environments`, and `local` is a sentinel key here
 * exactly as it is for install runs — the same reason
 * `external_account_limits_cache` and `external_agent_disclosures` key on
 * `userId`/`environmentId` without one.
 *
 * `nodeSelection`/`bunSelection` store a `ToolchainChoice`: `'auto'` or an
 * installation path already validated against a probe result.
 */
export const environmentToolchains: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('environment_toolchains')
      .ifNotExists()
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('environmentId', 'text', (col) => col.notNull())
      .addColumn('nodeSelection', 'text', (col) => col.notNull())
      .addColumn('bunSelection', 'text', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('environment_toolchains_pk', ['userId', 'environmentId'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('environment_toolchains').ifExists().execute();
  },
};
