/**
 * Migration 044 is the only repair for rows written while `chat` was still a
 * mode and an agent id. Once it has run, `'chat'` is unrepresentable in
 * `BuiltInAgentIdSchema`, so anything it leaves behind fails validation for
 * the life of the database — which makes these cases worth pinning against a
 * real SQLite file rather than a mocked query builder.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { BunSqliteDialect } from 'kysely-bun-sqlite/dist/index.js';
import { allMigrations } from '../../../src/db/migrations';

const BEFORE = '043_library_backups';
const TARGET = '044_chat_runner';

// biome-ignore lint/suspicious/noExplicitAny: the pre-044 schema is not the shape `Database` describes.
type AnyDb = Kysely<any>;

let sqlite: SQLiteDatabase;
let db: AnyDb;

function migrator(): Migrator {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(allMigrations) } });
}

async function migrateTo(name: string): Promise<void> {
  const { error } = await migrator().migrateTo(name);
  if (error) throw error;
}

async function seedUser(id: string): Promise<void> {
  await sql`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (${id}, ${id}, ${`${id}@example.test`}, 0, 0, 0)
  `.execute(db);
}

async function seedChat(id: string, lastUsedMode: string | null, agentId: string | null) {
  await sql`
    INSERT INTO chats (id, title, createdAt, updatedAt, userId, lastUsedMode, selectedAgentId)
    VALUES (${id}, ${id}, 0, 0, 'user-1', ${lastUsedMode}, ${agentId})
  `.execute(db);
}

async function readChat(id: string): Promise<{ runnerKind: string; runnerAgentId: string | null }> {
  const rows = await sql<{ runnerKind: string; runnerAgentId: string | null }>`
    SELECT runnerKind, runnerAgentId FROM chats WHERE id = ${id}
  `.execute(db);
  const row = rows.rows[0];
  if (!row) throw new Error(`chat ${id} vanished`);
  return row;
}

beforeEach(async () => {
  sqlite = new SQLiteDatabase(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  db = new Kysely({ dialect: new BunSqliteDialect({ database: sqlite }) });
  await migrateTo(BEFORE);
  await seedUser('user-1');
});

afterEach(async () => {
  await db.destroy();
});

describe('044_chat_runner chat rows', () => {
  it('carries a real agent selection onto the mangostudio runner', async () => {
    await seedChat('chat-agent', 'agent', 'user:reviewer');

    await migrateTo(TARGET);

    expect(await readChat('chat-agent')).toEqual({
      runnerKind: 'mangostudio',
      runnerAgentId: 'user:reviewer',
    });
  });

  it("repairs the GAP-1 'chat' sentinel to default", async () => {
    await seedChat('chat-sentinel', 'chat', 'chat');

    await migrateTo(TARGET);

    expect(await readChat('chat-sentinel')).toEqual({
      runnerKind: 'mangostudio',
      runnerAgentId: 'default',
    });
  });

  it('defaults a chat that never recorded a selection', async () => {
    await seedChat('chat-null', null, null);

    await migrateTo(TARGET);

    expect(await readChat('chat-null')).toEqual({
      runnerKind: 'mangostudio',
      runnerAgentId: 'default',
    });
  });

  it('carries an agent id whose profile no longer exists, leaving it to turn resolution', async () => {
    await seedChat('chat-dangling', 'agent', 'user:deleted');

    await migrateTo(TARGET);

    expect(await readChat('chat-dangling')).toEqual({
      runnerKind: 'mangostudio',
      runnerAgentId: 'user:deleted',
    });
  });
});

describe('044_chat_runner rollback', () => {
  async function readRestoredChat(id: string) {
    const rows = await sql<{ lastUsedMode: string | null; selectedAgentId: string | null }>`
      SELECT lastUsedMode, selectedAgentId FROM chats WHERE id = ${id}
    `.execute(db);
    const row = rows.rows[0];
    if (!row) throw new Error(`chat ${id} vanished`);
    return row;
  }

  // Post-044 every chat is an agent chat. Rolling back to a NULL `lastUsedMode`
  // would hand each of them back to the retired tool-less chat profile.
  it('restores agent mode alongside the agent selection', async () => {
    await seedChat('chat-agent', 'agent', 'user:reviewer');
    await seedChat('chat-plain', 'chat', 'chat');
    await migrateTo(TARGET);

    await migrateTo(BEFORE);

    expect(await readRestoredChat('chat-agent')).toEqual({
      lastUsedMode: 'agent',
      selectedAgentId: 'user:reviewer',
    });
    expect(await readRestoredChat('chat-plain')).toEqual({
      lastUsedMode: 'agent',
      selectedAgentId: 'default',
    });
  });
});

describe('044_chat_runner user_agent_settings rows', () => {
  /**
   * `settingsJson` is a whole serialized profile, so the stored `id` is what the
   * read path validates — seeding it keeps the embedded-id case honest.
   */
  async function seedAgentSetting(userId: string, agentId: string, model: string): Promise<void> {
    await sql`
      INSERT INTO user_agent_settings (id, userId, agentId, settingsJson, createdAt, updatedAt)
      VALUES (${`${userId}-${agentId}`}, ${userId}, ${agentId},
        ${JSON.stringify({ id: agentId, model })}, 0, 0)
    `.execute(db);
  }

  async function readAgentSettings(userId: string) {
    const rows = await sql<{ agentId: string; settingsJson: string }>`
      SELECT agentId, settingsJson FROM user_agent_settings
      WHERE userId = ${userId} ORDER BY agentId
    `.execute(db);
    return rows.rows.map((row) => ({ agentId: row.agentId, ...JSON.parse(row.settingsJson) }));
  }

  // The column and the profile id embedded in `settingsJson` have to move
  // together: `AgentProfileSchema` no longer accepts `'chat'`, so a row left
  // saying `"id":"chat"` fails validation on read and the saved settings are
  // silently replaced by synthesized defaults.
  it("moves a lone 'chat' row onto default, embedded profile id included", async () => {
    await seedAgentSetting('user-1', 'chat', 'model-from-chat');

    await migrateTo(TARGET);

    expect(await readAgentSettings('user-1')).toEqual([
      { agentId: 'default', id: 'default', model: 'model-from-chat' },
    ]);
  });

  it("keeps a configured default row and drops the conflicting 'chat' row", async () => {
    await seedAgentSetting('user-1', 'chat', 'model-from-chat');
    await seedAgentSetting('user-1', 'default', 'model-from-default');

    await migrateTo(TARGET);

    expect(await readAgentSettings('user-1')).toEqual([
      { agentId: 'default', id: 'default', model: 'model-from-default' },
    ]);
  });

  it('still moves the column when settingsJson is not a rewritable object', async () => {
    await sql`
      INSERT INTO user_agent_settings (id, userId, agentId, settingsJson, createdAt, updatedAt)
      VALUES ('user-1-broken', 'user-1', 'chat', 'not json', 0, 0)
    `.execute(db);

    await migrateTo(TARGET);

    const rows = await sql<{ agentId: string; settingsJson: string }>`
      SELECT agentId, settingsJson FROM user_agent_settings WHERE userId = 'user-1'
    `.execute(db);
    expect(rows.rows).toEqual([{ agentId: 'default', settingsJson: 'not json' }]);
  });
});

describe('044_chat_runner turn checkpoints', () => {
  async function seedMessage(id: string, parts: unknown): Promise<void> {
    await seedChat(id, 'agent', 'default');
    await sql`
      INSERT INTO messages (id, chatId, role, text, timestamp, isGenerating, interactionMode, parts)
      VALUES (${id}, ${id}, 'ai', '', 0, 0, 'agent', ${JSON.stringify(parts)})
    `.execute(db);
  }

  async function readParts(id: string): Promise<unknown> {
    const rows = await sql<{ parts: string }>`SELECT parts FROM messages WHERE id = ${id}`.execute(
      db
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`message ${id} vanished`);
    return JSON.parse(row.parts);
  }

  it("rewrites a checkpoint recorded against the removed 'chat' agent", async () => {
    await seedMessage('msg-chat', [
      { type: 'text', text: 'hi' },
      { type: 'turn_checkpoint', agentId: 'chat', agentName: 'Chat', sequence: 0 },
    ]);

    await migrateTo(TARGET);

    expect(await readParts('msg-chat')).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'turn_checkpoint', agentId: 'default', agentName: 'Chat', sequence: 0 },
    ]);
  });

  it('leaves a checkpoint for a surviving agent untouched', async () => {
    await seedMessage('msg-explore', [
      { type: 'turn_checkpoint', agentId: 'explore', agentName: 'Explore', sequence: 3 },
    ]);

    await migrateTo(TARGET);

    expect(await readParts('msg-explore')).toEqual([
      { type: 'turn_checkpoint', agentId: 'explore', agentName: 'Explore', sequence: 3 },
    ]);
  });

  it("does not touch a non-checkpoint part that happens to name 'chat'", async () => {
    await seedMessage('msg-other', [{ type: 'subagent_started', agentId: 'chat', callId: 'c1' }]);

    await migrateTo(TARGET);

    expect(await readParts('msg-other')).toEqual([
      { type: 'subagent_started', agentId: 'chat', callId: 'c1' },
    ]);
  });
});
