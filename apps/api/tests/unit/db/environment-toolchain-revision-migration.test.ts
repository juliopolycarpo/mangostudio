import { Database as SQLiteDatabase } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { acquireCaptureLock } from '../../../src/backup/capture-lock';
import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';
import { prepareToolchainDatabase } from '../../../src/server/migrations';

it.each(['fresh', 'interrupted'] as const)(
  'assigns distinct revisions to saved environments on a %s upgrade',
  async (mode) => {
    const sqlite = new SQLiteDatabase(':memory:');
    const db = new Kysely<Database>({ dialect: createBunSqliteDialect(sqlite) });
    try {
      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(allMigrations) },
      });
      expect(
        (await migrator.migrateTo('061_remove_orphan_environment_toolchains')).error
      ).toBeUndefined();
      await db
        .insertInto('environments')
        .values(
          ['box-1', 'box-2'].map((id) => ({
            id,
            userId: 'owner',
            name: id,
            transportKind: 'stdio',
            configJson: '{}',
            enabled: 1,
            allowInstalls: 0,
            createdAt: 1,
            updatedAt: 1,
          }))
        )
        .execute();

      const priorRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      if (mode === 'interrupted') {
        // SQLite committed the schema and one backfill before the receipt was recorded.
        await sql`ALTER TABLE environments ADD COLUMN toolchainRevision TEXT NOT NULL DEFAULT ''`.execute(
          db
        );
        await db
          .updateTable('environments')
          .set({ toolchainRevision: priorRevision })
          .where('id', '=', 'box-1')
          .execute();
      }
      expect(
        (await migrator.migrateTo('062_environment_toolchain_revision')).error
      ).toBeUndefined();
      const rows = await db
        .selectFrom('environments')
        .select(['id', 'toolchainRevision'])
        .orderBy('id')
        .execute();
      expect(rows.map(({ id }) => id)).toEqual(['box-1', 'box-2']);
      expect(rows.every(({ toolchainRevision }) => /^[a-f0-9]{32}$/.test(toolchainRevision))).toBe(
        true
      );
      expect(new Set(rows.map(({ toolchainRevision }) => toolchainRevision)).size).toBe(2);
      if (mode === 'interrupted') expect(rows[0]?.toolchainRevision).toBe(priorRevision);
    } finally {
      await db.destroy();
    }
  }
);

it('leaves schema 061 in place while the Hub owns the database and upgrades after release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mango-toolchain-db-'));
  const path = join(directory, 'hub.sqlite');
  const sqlite = new SQLiteDatabase(path);
  const db = new Kysely<Database>({ dialect: createBunSqliteDialect(sqlite) });
  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(allMigrations) },
    });
    expect(
      (await migrator.migrateTo('061_remove_orphan_environment_toolchains')).error
    ).toBeUndefined();
    const release = await acquireCaptureLock(path);
    try {
      await expect(prepareToolchainDatabase(db, path)).rejects.toThrow(
        /^The database needs an upgrade\. Stop the Hub.*User data is already in use/
      );
      const tables = await db.introspection.getTables();
      const columns = tables.find(({ name }) => name === 'environments')?.columns;
      expect(columns?.some(({ name }) => name === 'toolchainRevision')).toBe(false);
    } finally {
      await release();
    }

    await prepareToolchainDatabase(db, path);
    const migrations = await migrator.getMigrations();
    expect(
      migrations.find(({ name }) => name === '062_environment_toolchain_revision')?.executedAt
    ).toBeInstanceOf(Date);

    const releaseUpgraded = await acquireCaptureLock(path);
    try {
      await expect(prepareToolchainDatabase(db, path)).resolves.toBeUndefined();
    } finally {
      await releaseUpgraded();
    }
  } finally {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
