/**
 * Migration 067 adds `messages.expandedText`. Rows written before it must read
 * back as NULL, which history treats as "replay `text` as typed".
 */
import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';

const TARGET = '067_message_expanded_text';
const PREVIOUS = '066_chat_search_text';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrating incrementally through schemas `Database` does not describe.
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

async function messageColumns(): Promise<Array<{ name: string; notnull: number }>> {
  const result = await sql<{ name: string; notnull: number }>`PRAGMA table_info(messages)`.execute(
    db
  );
  return result.rows;
}

beforeEach(() => {
  sqlite = new SQLiteDatabase(':memory:');
  db = new Kysely({ dialect: createBunSqliteDialect(sqlite) });
});

afterEach(() => {
  sqlite.close();
});

describe('067_message_expanded_text', () => {
  it('adds a nullable expandedText column', async () => {
    await migrateTo(PREVIOUS);
    expect((await messageColumns()).map((column) => column.name)).not.toContain('expandedText');

    await migrateTo(TARGET);

    const column = (await messageColumns()).find(({ name }) => name === 'expandedText');
    expect(column, '(messages.expandedText): expected a column after the migration').toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  it('leaves a pre-existing message with a NULL expansion', async () => {
    await migrateTo(PREVIOUS);
    await sql`INSERT INTO messages (id, chatId, role, text, timestamp, isGenerating, interactionMode)
      VALUES ('m1', 'c1', 'user', '/review a.ts', 1, 0, 'chat')`.execute(db);

    await migrateTo(TARGET);

    const row = await sql<{
      expandedText: string | null;
    }>`SELECT expandedText FROM messages WHERE id = 'm1'`.execute(db);
    expect(row.rows[0]?.expandedText).toBeNull();
  });
});
