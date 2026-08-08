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
 *   to a live profile, carries through unchanged — turn resolution falls back
 *   to `default` when the profile is gone (see `resolveRunnerAgentProfile`),
 *   not this migration.
 * - `user_agent_settings` rows for the removed `chat` profile move onto
 *   `default`, embedded profile `id` included. If a `default` row already
 *   exists for that user, the existing `default` row wins and the `chat` row is
 *   dropped, to avoid clobbering a user's configured default agent with the
 *   tool-less chat profile.
 * - `turn_checkpoint` message parts recorded against the `chat` profile move
 *   onto `default`. `'chat'` has left `BuiltInAgentIdSchema`, and
 *   `isTurnCheckpointPart` validates the whole part, so leaving these rows
 *   alone would make every pre-upgrade interrupted turn fail to resume.
 */

/** Shape this migration cares about; the rest of the part is carried through. */
interface CheckpointCandidatePart {
  type?: unknown;
  agentId?: unknown;
}

/**
 * Rewrites `agentId: 'chat'` on turn checkpoints, returning null when the row
 * needs no write. Unparsable `parts` are left untouched rather than dropped —
 * a message this migration cannot read is not a message it should rewrite.
 */
function repairCheckpointAgentIds(parts: string): string | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(parts);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;

  let changed = false;
  const repaired = decoded.map((part) => {
    const candidate = part as CheckpointCandidatePart | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      candidate.type !== 'turn_checkpoint' ||
      candidate.agentId !== 'chat'
    ) {
      return part;
    }
    changed = true;
    return { ...candidate, agentId: 'default' };
  });

  return changed ? JSON.stringify(repaired) : null;
}

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

    // `settingsJson` is a whole serialized profile, so its embedded `id` has to
    // move with the column. `AgentProfileSchema` no longer accepts `'chat'`, and
    // `parseAgentSettingsRow` validates the JSON before returning it — a row
    // left saying `"id":"chat"` would be dropped on read and the user's saved
    // prompt, model and tool choices replaced by synthesized defaults.
    const migrated = await sql`
      UPDATE user_agent_settings
      SET agentId = 'default',
        settingsJson = json_set(settingsJson, '$.id', 'default')
      WHERE agentId = 'chat' AND json_valid(settingsJson) AND json_type(settingsJson) = 'object'
    `.execute(db);

    // A row whose settings are not a JSON object cannot be rewritten in place;
    // move the column anyway so nothing is left claiming the removed agent, and
    // let the read path fall back to defaults for that one row.
    const unparsable = await sql`
      UPDATE user_agent_settings SET agentId = 'default' WHERE agentId = 'chat'
    `.execute(db);

    const checkpointRows = await sql<{ id: string; parts: string }>`
      SELECT id, parts FROM messages
      WHERE parts IS NOT NULL AND parts LIKE '%turn_checkpoint%'
    `.execute(db);

    let repairedCheckpoints = 0;
    for (const row of checkpointRows.rows) {
      const repaired = repairCheckpointAgentIds(row.parts);
      if (repaired === null) continue;
      await sql`UPDATE messages SET parts = ${repaired} WHERE id = ${row.id}`.execute(db);
      repairedCheckpoints += 1;
    }

    console.warn(
      `[migrate 044_chat_runner] dropped ${conflicting.rows.length} conflicting 'chat' ` +
        `user_agent_settings rows (kept 'default'); moved ${Number(migrated.numAffectedRows ?? 0)} ` +
        `remaining 'chat' rows onto 'default' (${Number(unparsable.numAffectedRows ?? 0)} with ` +
        `settings this migration could not rewrite); repaired ${repairedCheckpoints} turn checkpoints ` +
        `recorded against the removed 'chat' agent.`
    );

    await db.schema.alterTable('chats').dropColumn('lastUsedMode').execute();
    await db.schema.alterTable('chats').dropColumn('selectedAgentId').execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('chats').addColumn('lastUsedMode', 'text').execute();
    await db.schema.alterTable('chats').addColumn('selectedAgentId', 'text').execute();

    // Every chat runs as an agent once 044 is up, so a rollback has to say so.
    // Leaving `lastUsedMode` NULL would make the restored `use-agent-selection`
    // read every chat as the tool-less chat profile — silently dropping the
    // tools and workdir the chat has been running with since the upgrade.
    await sql`UPDATE chats SET lastUsedMode = 'agent', selectedAgentId = runnerAgentId`.execute(db);

    await db.schema.alterTable('chats').dropColumn('runnerKind').execute();
    await db.schema.alterTable('chats').dropColumn('runnerAgentId').execute();
    await db.schema.alterTable('chats').dropColumn('runnerTargetId').execute();
  },
};
