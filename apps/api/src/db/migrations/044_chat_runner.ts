import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Replaces `chats.lastUsedMode` + `chats.selectedAgentId` with a typed runner
 * configuration (`runnerKind` / `runnerAgentId` / `runnerTargetId`).
 *
 * Data policy for existing rows:
 * - `selectedAgentId = 'chat'` (the GAP-1 sentinel for "none") normalizes to
 *   `'default'`, same as a null selection.
 * - Any other `selectedAgentId` value, including one that no longer resolves
 *   to a live profile, carries through unchanged — the repository read path
 *   normalizes an unresolvable id at read time, not this migration.
 * - `user_agent_settings` rows for the removed `chat` profile move onto
 *   `default`. If a `default` row already exists for that user, the existing
 *   `default` row wins and the `chat` row is dropped, to avoid clobbering a
 *   user's configured default agent with the tool-less chat profile.
 */
export const chatRunner: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('chats')
      .addColumn('runnerKind', 'text', (col) => col.notNull().defaultTo('mangostudio'))
      .execute();
    await db.schema
      .alterTable('chats')
      .addColumn('runnerAgentId', 'text', (col) => col.defaultTo('default'))
      .execute();
    await db.schema.alterTable('chats').addColumn('runnerTargetId', 'text').execute();

    await sql`
      UPDATE chats SET runnerKind = 'mangostudio',
        runnerAgentId = CASE
          WHEN selectedAgentId IS NULL OR selectedAgentId = 'chat' THEN 'default'
          ELSE selectedAgentId
        END
    `.execute(db);

    const conflicting = await sql<{ userId: string }>`
      SELECT chatRow.userId AS userId
      FROM user_agent_settings chatRow
      INNER JOIN user_agent_settings defaultRow
        ON defaultRow.userId = chatRow.userId AND defaultRow.agentId = 'default'
      WHERE chatRow.agentId = 'chat'
    `.execute(db);

    await sql`
      DELETE FROM user_agent_settings
      WHERE agentId = 'chat'
        AND userId IN (
          SELECT userId FROM user_agent_settings WHERE agentId = 'default'
        )
    `.execute(db);

    const migrated = await sql`
      UPDATE user_agent_settings SET agentId = 'default' WHERE agentId = 'chat'
    `.execute(db);

    console.warn(
      `[migrate 044_chat_runner] dropped ${conflicting.rows.length} conflicting 'chat' ` +
        `user_agent_settings rows (kept 'default'); moved ${Number(migrated.numAffectedRows ?? 0)} ` +
        `remaining 'chat' rows onto 'default'.`
    );

    await db.schema.alterTable('chats').dropColumn('lastUsedMode').execute();
    await db.schema.alterTable('chats').dropColumn('selectedAgentId').execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('chats').addColumn('lastUsedMode', 'text').execute();
    await db.schema.alterTable('chats').addColumn('selectedAgentId', 'text').execute();

    await sql`UPDATE chats SET selectedAgentId = runnerAgentId`.execute(db);

    await db.schema.alterTable('chats').dropColumn('runnerKind').execute();
    await db.schema.alterTable('chats').dropColumn('runnerAgentId').execute();
    await db.schema.alterTable('chats').dropColumn('runnerTargetId').execute();
  },
};
