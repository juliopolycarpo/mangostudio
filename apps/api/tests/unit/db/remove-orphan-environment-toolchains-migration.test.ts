import { Database as SQLiteDatabase } from 'bun:sqlite';
import { expect, it } from 'bun:test';

import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';

it('removes orphan toolchains and preserves owned selections and virtual Local', async () => {
  const sqlite = new SQLiteDatabase(':memory:');
  const db = new Kysely<Database>({ dialect: createBunSqliteDialect(sqlite) });
  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(allMigrations) },
    });
    expect((await migrator.migrateTo('060_product_operations')).error).toBeUndefined();
    await db
      .insertInto('environments')
      .values({
        userId: 'owner',
        id: 'box',
        name: 'Box',
        transportKind: 'stdio',
        configJson: '{}',
        enabled: 1,
        allowInstalls: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      .execute();
    await db
      .insertInto('environment_toolchains')
      .values(
        [
          { userId: 'owner', environmentId: 'box' },
          { userId: 'owner', environmentId: 'deleted-box' },
          { userId: 'other', environmentId: 'box' },
          { userId: 'other', environmentId: 'local' },
        ].map((key) => ({ ...key, nodeSelection: '/opt/node', bunSelection: 'auto', updatedAt: 1 }))
      )
      .execute();

    expect(
      (await migrator.migrateTo('061_remove_orphan_environment_toolchains')).error
    ).toBeUndefined();
    expect(
      await db
        .selectFrom('environment_toolchains')
        .select(['userId', 'environmentId', 'nodeSelection'])
        .orderBy('environmentId')
        .execute()
    ).toEqual([
      { userId: 'owner', environmentId: 'box', nodeSelection: '/opt/node' },
      { userId: 'other', environmentId: 'local', nodeSelection: '/opt/node' },
    ]);
  } finally {
    await db.destroy();
  }
});
