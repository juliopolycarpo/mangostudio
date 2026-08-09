import type { Migration } from 'kysely/migration';

/**
 * Adds the per-chat external permission choice: `runnerPermissionLevel` and
 * `runnerApprovalRouting`.
 *
 * Separate from 044 on purpose. 044 landed the runner configuration long before
 * a permission contract existed, and a column with no schema behind it is worse
 * than a second migration: it invites writes nothing validates and reads nothing
 * can interpret.
 *
 * Both are nullable `TEXT` and both are read through
 * `normalizePermissionLevel` / `normalizeApprovalRouting`, which resolve NULL
 * and anything unrecognized to the restrictive end of each axis. That is what
 * makes the columns forward-compatible while the unions in
 * `@mangostudio/shared/external-agents` stay closed: a downgrade reading a level
 * a later version wrote gets `read-only`, not an unhandled value.
 *
 * Nothing is backfilled. A NULL here means "this chat has not chosen", which is
 * exactly true of every chat that exists when this runs, and writing a default
 * would make the restrictive fallback indistinguishable from a deliberate
 * choice.
 */
export const chatRunnerPermissions: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('chats').addColumn('runnerPermissionLevel', 'text').execute();
    await db.schema.alterTable('chats').addColumn('runnerApprovalRouting', 'text').execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('chats').dropColumn('runnerPermissionLevel').execute();
    await db.schema.alterTable('chats').dropColumn('runnerApprovalRouting').execute();
  },
};
