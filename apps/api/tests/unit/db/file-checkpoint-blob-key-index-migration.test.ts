/**
 * Migration 070 indexes `file_checkpoints.blobKey`. `releaseCheckpointBlobs`
 * asks, once per blob key, whether any row still points at it; the plan is read
 * from the SQL that call actually sends, so a reshaped query that stops using
 * the index fails here.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type CompiledQuery, Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';
import { releaseCheckpointBlobs } from '../../../src/modules/file-checkpoints/infrastructure/checkpoint-repository';

const BEFORE = '069_message_cascade_lookup_indexes';
const TARGET = '070_file_checkpoint_blob_key_index';
const INDEX = 'idx_file_checkpoints_blob_key';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pre-070 schema is not the shape `Database` describes.
type AnyDb = Kysely<any>;

let sqlite: SQLiteDatabase;
let db: AnyDb;
let executed: CompiledQuery[];

async function migrateTo(name: string): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  });
  const { error } = await migrator.migrateTo(name);
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- The migration error is rethrown unchanged so the test observes the original failure.
  if (error) throw error;
}

/** The blob reference check `releaseCheckpointBlobs` sends for an unknown key, planned as sent. */
async function blobReferencePlan(): Promise<string[]> {
  executed = [];
  await releaseCheckpointBlobs(db as Kysely<Database>, ['not-a-stored-blob']);
  const checks = executed.filter((query) => /from "file_checkpoints"/.test(query.sql));
  if (checks.length !== 1) {
    throw new Error(
      `expected blob reference checks: 1 | received: ${checks.length} (${JSON.stringify(
        executed.map((query) => query.sql)
      )})`
    );
  }
  const check = checks[0] as CompiledQuery;
  const statement = sqlite.prepare(`EXPLAIN QUERY PLAN ${check.sql}`);
  const rows = statement.all(...(check.parameters as never[])) as { detail: string }[];
  statement.finalize();
  return rows.map((row) => row.detail);
}

beforeEach(async () => {
  sqlite = new SQLiteDatabase(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  executed = [];
  db = new Kysely({
    dialect: createBunSqliteDialect(sqlite),
    log: (event) => {
      if (event.level === 'query') executed.push(event.query);
    },
  });
  await migrateTo(BEFORE);
});

afterEach(async () => {
  await db.destroy();
});

describe('070_file_checkpoint_blob_key_index', () => {
  it('scans file_checkpoints for the blob reference check before the migration', async () => {
    const plan = await blobReferencePlan();

    expect(plan).toEqual(['SCAN file_checkpoints']);
  });

  it('seeks the blob reference check through the blobKey index after the migration', async () => {
    await migrateTo(TARGET);

    const plan = await blobReferencePlan();

    if (plan.some((line) => line.startsWith('SCAN'))) {
      throw new Error(`expected a SEARCH on ${INDEX} | received: ${JSON.stringify(plan)}`);
    }
    expect(plan[0]).toContain(`SEARCH file_checkpoints USING COVERING INDEX ${INDEX} (blobKey=?)`);
  });

  it('drops the index on the way down', async () => {
    await migrateTo(TARGET);

    await migrateTo(BEFORE);

    const found = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${INDEX}`.execute(db);
    expect(found.rows).toEqual([]);
  });
});
