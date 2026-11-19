/**
 * Migration 068 adds `file_checkpoints.source`. Rows written before it exist
 * only because a builtin mutator snapshotted a path, so they must read back as
 * `builtin`; reading them as anything else would make the revert dialog warn
 * about concurrent writers on turns that never had a shell capture.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';

const BEFORE = '066_chat_search_text';
const TARGET = '068_file_checkpoint_source';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pre-068 schema is not the shape `Database` describes.
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

async function seedCheckpointRow(): Promise<void> {
  await sql`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('user-1', 'user-1', 'user-1@example.test', 0, 0, 0)
  `.execute(db);
  await sql`
    INSERT INTO chats (id, title, createdAt, updatedAt, userId)
    VALUES ('chat-1', 'Chat', 0, 0, 'user-1')
  `.execute(db);
  await sql`
    INSERT INTO messages (id, chatId, role, text, timestamp, isGenerating, interactionMode)
    VALUES ('message-1', 'chat-1', 'ai', '', 0, 0, 'chat')
  `.execute(db);
  await sql`
    INSERT INTO file_checkpoints (chatId, messageId, path, op, afterHash, createdAt)
    VALUES ('chat-1', 'message-1', '/work/a.txt', 'edit', 'hash', 0)
  `.execute(db);
}

beforeEach(async () => {
  sqlite = new SQLiteDatabase(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  db = new Kysely({ dialect: createBunSqliteDialect(sqlite) });
  await migrateTo(BEFORE);
});

afterEach(async () => {
  await db.destroy();
});

describe('068_file_checkpoint_source', () => {
  it('reads rows that predate the column back as builtin', async () => {
    await seedCheckpointRow();

    await migrateTo(TARGET);

    const rows = await sql<{ source: string }>`SELECT source FROM file_checkpoints`.execute(db);
    expect(rows.rows).toEqual([{ source: 'builtin' }]);
  });

  it('drops the column on the way down and keeps the rows', async () => {
    await seedCheckpointRow();
    await migrateTo(TARGET);

    await migrateTo(BEFORE);

    const columns = await sql<{ name: string }>`PRAGMA table_info(file_checkpoints)`.execute(db);
    expect(columns.rows.map((column) => column.name)).not.toContain('source');
    const rows = await sql<{ path: string }>`SELECT path FROM file_checkpoints`.execute(db);
    expect(rows.rows).toEqual([{ path: '/work/a.txt' }]);
  });
});
