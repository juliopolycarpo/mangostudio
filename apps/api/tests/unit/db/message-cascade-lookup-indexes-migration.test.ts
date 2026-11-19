/**
 * Migration 069 indexes `file_checkpoints.messageId` and
 * `message_uncheckpointed_sources.messageId`. Deleting a chat cascades through
 * its messages, and SQLite finds each deleted message's children with exactly
 * the lookup planned below; without an index leading with `messageId` that
 * lookup scans the whole child table once per message.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';

const BEFORE = '068_file_checkpoint_source';
const TARGET = '069_message_cascade_lookup_indexes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pre-069 schema is not the shape `Database` describes.
type AnyDb = Kysely<any>;

let sqlite: SQLiteDatabase;
let db: AnyDb;

async function migrateTo(name: string): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  });
  const { error } = await migrator.migrateTo(name);
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- The migration error is rethrown unchanged so the test observes the original failure.
  if (error) throw error;
}

/** The lookup SQLite runs per deleted message to find the rows that reference it. */
function childLookupPlan(table: string): string[] {
  const rows = sqlite
    .query(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE messageId = ?`)
    .all('message-1') as { detail: string }[];
  return rows.map((row) => row.detail);
}

async function seedChatWithChildren(chatId: string): Promise<void> {
  const messageId = `${chatId}-message`;
  await sql`INSERT INTO chats (id, title, createdAt, updatedAt, userId)
    VALUES (${chatId}, 'Chat', 0, 0, 'user-1')`.execute(db);
  await sql`INSERT INTO messages (id, chatId, role, text, timestamp, isGenerating, interactionMode)
    VALUES (${messageId}, ${chatId}, 'ai', '', 0, 0, 'chat')`.execute(db);
  await sql`INSERT INTO file_checkpoints (chatId, messageId, path, op, afterHash, createdAt)
    VALUES (${chatId}, ${messageId}, '/work/a.txt', 'edit', 'hash', 0)`.execute(db);
  await sql`INSERT INTO message_uncheckpointed_sources (chatId, messageId, source, createdAt)
    VALUES (${chatId}, ${messageId}, 'shell', 0)`.execute(db);
}

async function countRows(table: string): Promise<number> {
  const result = await sql<{
    rows: number;
  }>`SELECT count(*) AS rows FROM ${sql.table(table)}`.execute(db);
  return result.rows[0]?.rows ?? -1;
}

beforeEach(async () => {
  sqlite = new SQLiteDatabase(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  db = new Kysely({ dialect: createBunSqliteDialect(sqlite) });
  await migrateTo(BEFORE);
  await sql`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('user-1', 'user-1', 'user-1@example.test', 0, 0, 0)`.execute(db);
});

afterEach(async () => {
  await db.destroy();
});

describe('069_message_cascade_lookup_indexes', () => {
  it.each(['file_checkpoints', 'message_uncheckpointed_sources'])(
    'scans %s for each deleted message before the migration',
    (table) => {
      const plan = childLookupPlan(table);

      expect(plan.some((line) => line.startsWith(`SCAN ${table}`))).toBe(true);
    }
  );

  it.each(['file_checkpoints', 'message_uncheckpointed_sources'])(
    'seeks %s by messageId after the migration',
    async (table) => {
      await migrateTo(TARGET);

      const plan = childLookupPlan(table);

      if (plan.some((line) => line.startsWith('SCAN'))) {
        throw new Error(
          `expected a SEARCH on ${table}(messageId) | received: ${JSON.stringify(plan)}`
        );
      }
      expect(plan[0]).toContain(`SEARCH ${table} USING`);
      expect(plan[0]).toContain('(messageId=?)');
    }
  );

  it('still removes a deleted chat’s checkpoints and sources and leaves the others', async () => {
    await migrateTo(TARGET);
    await seedChatWithChildren('chat-1');
    await seedChatWithChildren('chat-2');

    await sql`DELETE FROM chats WHERE id = 'chat-1'`.execute(db);

    expect(await countRows('file_checkpoints')).toBe(1);
    expect(await countRows('message_uncheckpointed_sources')).toBe(1);
    const violations = sqlite.query('PRAGMA foreign_key_check').all();
    expect(violations).toEqual([]);
  });

  it('drops both indexes on the way down', async () => {
    await migrateTo(TARGET);

    await migrateTo(BEFORE);

    const names = sqlite
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_file_checkpoints_message', 'idx_message_uncheckpointed_sources_message')`
      )
      .all();
    expect(names).toEqual([]);
  });
});
