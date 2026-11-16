/**
 * Migration 065 adds the table that holds a streaming turn's checkpoint deltas,
 * and the trigger that removes them when the turn stops generating.
 */
import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';

const TARGET = '065_message_checkpoint_deltas';
const PREVIOUS = '063_messages_ordered_read_indexes';
const TABLE = 'message_checkpoint_deltas';
const TRIGGER = 'trg_message_checkpoint_deltas_cleanup';

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

async function schemaObject(type: 'table' | 'trigger', name: string): Promise<string | null> {
  const result = await sql<{
    sql: string;
  }>`SELECT sql FROM sqlite_master WHERE type = ${type} AND name = ${name}`.execute(db);
  return result.rows[0]?.sql ?? null;
}

beforeEach(() => {
  sqlite = new SQLiteDatabase(':memory:');
  db = new Kysely({ dialect: createBunSqliteDialect(sqlite) });
});

afterEach(() => {
  sqlite.close();
});

describe('065_message_checkpoint_deltas', () => {
  it('creates a WITHOUT ROWID table keyed by message and sequence, and the cleanup trigger', async () => {
    await migrateTo(PREVIOUS);
    expect(await schemaObject('table', TABLE)).toBeNull();

    await migrateTo(TARGET);

    const table = await schemaObject('table', TABLE);
    expect(table).toContain('primary key ("messageId", "seq")');
    expect(table).toMatch(/without rowid$/i);
    expect(await schemaObject('trigger', TRIGGER)).toContain('AFTER UPDATE OF isGenerating');
  });

  it('removes the table and the trigger on the way down', async () => {
    await migrateTo(TARGET);

    await migrateTo(PREVIOUS);

    expect({
      table: await schemaObject('table', TABLE),
      trigger: await schemaObject('trigger', TRIGGER),
    }).toEqual({ table: null, trigger: null });
  });
});
