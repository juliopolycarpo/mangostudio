/** File-backed storage probe: separate invocations have separate process ownership. */
import { Database as SQLite } from 'bun:sqlite';

import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';
import {
  claimOperation,
  operationReceipt,
  readOperation,
} from '../../../src/modules/operations/application/product-operation';

const [path, mode] = process.argv.slice(2);
if (!path) throw new Error('fixture needs a database path');
const db = new Kysely<Database>({ dialect: createBunSqliteDialect(new SQLite(path)) });
try {
  if (mode === 'reserve') {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(allMigrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error
        ? error
        : new Error('fixture migration failed', { cause: error });
    await db
      .insertInto('user')
      .values({
        id: 'fixture-owner',
        name: 'Fixture',
        email: 'fixture@example.test',
        emailVerified: 0,
        image: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .execute();
    await claimOperation(db, 'fixture-owner', 'durable', 'submit-turn', { prompt: 'fixture' });
  } else {
    const row = await readOperation(db, 'fixture-owner', 'durable');
    if (!row) throw new Error('receipt was lost');
    const replay = await claimOperation(db, 'fixture-owner', 'durable', 'submit-turn', {
      prompt: 'fixture',
    });
    await Bun.write(
      Bun.stdout,
      JSON.stringify({ receipt: operationReceipt(row), claimed: replay.claimed })
    );
  }
} finally {
  await db.destroy();
}
