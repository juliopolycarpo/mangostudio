/**
 * Migration 052 clears `library_divergence_acks` because the manifest-injectivity fix (#704)
 * bumped `DIRECTORY_HASH_DOMAIN`: every stored directory content hash changes, so an ack row's
 * `contentHashesJson` can never match a freshly computed hash again. Replayed against a real
 * (in-memory) SQLite engine so a future migration cannot quietly narrow the delete and leave
 * stale rows behind.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { BunSqliteDialect } from 'kysely-bun-sqlite/dist/index.js';
import { allMigrations } from '../../../src/db/migrations';

const TARGET = '052_clear_stale_divergence_acks';

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

beforeEach(() => {
  sqlite = new SQLiteDatabase(':memory:');
  db = new Kysely({ dialect: new BunSqliteDialect({ database: sqlite }) });
});

afterEach(() => {
  sqlite.close();
});

describe('052_clear_stale_divergence_acks', () => {
  it('deletes every stored acknowledgement, stale under the new manifest format', async () => {
    await migrateTo('033_profile_scoped_app_settings');
    await sql`
      INSERT INTO library_divergence_acks
        (id, userId, profileId, resourceKey, divergenceKey, contentHashesJson, acknowledgedAt)
      VALUES
        ('ack-1', 'user-1', 'default', 'skill:gh', 'digest-1', '["hash-a","hash-b"]', 1000),
        ('ack-2', 'user-1', 'default', 'instruction:global', 'digest-2', '["hash-c"]', 2000)
    `.execute(db);

    const before = await sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM library_divergence_acks`.execute(db);
    expect(before.rows[0]?.count).toBe(2);

    await migrateTo(TARGET);

    const after = await sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM library_divergence_acks`.execute(db);
    expect(after.rows[0]?.count).toBe(0);
  });
});
