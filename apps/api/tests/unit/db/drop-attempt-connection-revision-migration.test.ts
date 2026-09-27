/**
 * Migration 057 removes `external_turn_attempts.connectionRevision` from a
 * database that ran an earlier draft of 056, and is a no-op on one that did
 * not. Replayed against a real (in-memory) SQLite engine.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { BunSqliteDialect } from 'kysely-bun-sqlite/dist/index.js';
import { allMigrations } from '../../../src/db/migrations';

const TARGET = '057_drop_attempt_connection_revision';

// biome-ignore lint/suspicious/noExplicitAny: migrating incrementally through schemas `Database` does not describe.
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

async function attemptColumns(): Promise<string[]> {
  const result = await sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('external_turn_attempts')`.execute(db);
  return result.rows.map((row) => row.name);
}

async function insertReceipt(): Promise<void> {
  await sql`INSERT INTO chats (id, title, createdAt, updatedAt) VALUES ('chat-1', 't', 1, 1)`.execute(
    db
  );
  await sql`
    INSERT INTO external_turn_attempts
      (id, messageId, chatId, userId, environmentId, sessionId, clientMessageId,
       inputFingerprint, state, createdAt, updatedAt)
    VALUES
      ('a-1', 'm-1', 'chat-1', 'u-1', 'local', 's-1', 'c-1', 'sha256:0',
       'acceptance-unknown', 1, 1)
  `.execute(db);
}

beforeEach(() => {
  sqlite = new SQLiteDatabase(':memory:');
  db = new Kysely({ dialect: new BunSqliteDialect({ database: sqlite }) });
});

afterEach(() => {
  sqlite.close();
});

describe('057_drop_attempt_connection_revision', () => {
  it('drops the column an earlier 056 draft created, so a receipt without it inserts', async () => {
    await migrateTo('056_external_turn_attempts');
    // What the earlier draft of 056 left behind.
    await sql`ALTER TABLE external_turn_attempts ADD COLUMN connectionRevision integer NOT NULL DEFAULT 0`.execute(
      db
    );

    await migrateTo(TARGET);

    expect(await attemptColumns()).not.toContain('connectionRevision');
    await insertReceipt();
  });

  it('leaves a table that never had the column unchanged', async () => {
    await migrateTo('056_external_turn_attempts');
    const before = await attemptColumns();

    await migrateTo(TARGET);

    expect(await attemptColumns()).toEqual(before);
  });
});
