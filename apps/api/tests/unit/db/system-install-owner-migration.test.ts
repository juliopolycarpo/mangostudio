/**
 * Migration 071 creates the reserved owner row that accountless installs are
 * recorded under. Before it, `environment_install_runs.userId` had a foreign key
 * to `user.id` and no row for the CLI's literal `local` user, so the audit insert
 * failed before the installer ran.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import { SYSTEM_OWNER_EMAIL, SYSTEM_OWNER_USER_ID } from '../../../src/db/system-owner';

const BEFORE = '069_message_cascade_lookup_indexes';
const TARGET = '071_system_install_owner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pre-071 schema is not the shape `Database` describes.
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

function insertInstallRunAs(userId: string) {
  return sql`INSERT INTO environment_install_runs
    (id, userId, recipeId, argvJson, startedAt, status, truncated)
    VALUES ('run-1', ${userId}, 'bun.update', '[]', 0, 'running', 0)`.execute(db);
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

describe('071_system_install_owner', () => {
  it('rejects an install run for the reserved owner before the migration', async () => {
    await expect(insertInstallRunAs(SYSTEM_OWNER_USER_ID)).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('lets an install run be recorded under the reserved owner after the migration', async () => {
    await migrateTo(TARGET);

    await insertInstallRunAs(SYSTEM_OWNER_USER_ID);

    const rows = await sql<{ userId: string }>`SELECT userId FROM environment_install_runs`.execute(
      db
    );
    expect(rows.rows).toEqual([{ userId: SYSTEM_OWNER_USER_ID }]);
  });

  it('creates the row the application constants name, with no credential to sign in with', async () => {
    await migrateTo(TARGET);

    const users = await sql<{ id: string; email: string }>`SELECT id, email FROM user`.execute(db);
    expect(users.rows).toEqual([{ id: SYSTEM_OWNER_USER_ID, email: SYSTEM_OWNER_EMAIL }]);
    const accounts =
      await sql`SELECT 1 FROM account WHERE userId = ${SYSTEM_OWNER_USER_ID}`.execute(db);
    expect(accounts.rows).toHaveLength(0);
    const sessions =
      await sql`SELECT 1 FROM session WHERE userId = ${SYSTEM_OWNER_USER_ID}`.execute(db);
    expect(sessions.rows).toHaveLength(0);
  });

  it('leaves a row that already holds the id alone', async () => {
    await sql`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (${SYSTEM_OWNER_USER_ID}, 'kept', 'kept@example.test', 0, 0, 0)`.execute(db);

    await migrateTo(TARGET);

    const users = await sql<{ name: string }>`SELECT name FROM user`.execute(db);
    expect(users.rows).toEqual([{ name: 'kept' }]);
  });

  it('removes only the reserved row when rolled back', async () => {
    await migrateTo(TARGET);
    await sql`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('real-user', 'real', 'real@example.test', 0, 0, 0)`.execute(db);

    await migrateTo(BEFORE);

    const users = await sql<{ id: string }>`SELECT id FROM user`.execute(db);
    expect(users.rows).toEqual([{ id: 'real-user' }]);
  });
});
