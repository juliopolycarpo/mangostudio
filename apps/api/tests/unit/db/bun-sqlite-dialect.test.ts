import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type Generated, Kysely, sql } from 'kysely';
import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';

interface TestDatabase {
  items: { id: Generated<number>; name: string; payload: Uint8Array | null };
}

let sqlite: Database;
let db: Kysely<TestDatabase>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  db = new Kysely<TestDatabase>({ dialect: createBunSqliteDialect(sqlite) });
  await db.schema
    .createTable('items')
    .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
    .addColumn('name', 'text', (column) => column.notNull().unique())
    .addColumn('payload', 'blob')
    .execute();
});

afterEach(async () => {
  await db.destroy();
});

describe('Bun SQLite dialect', () => {
  it('binds values and preserves insert IDs, affected counts, blobs and nulls', async () => {
    const payload = new Uint8Array([0, 128, 255]);
    const inserted = await db
      .insertInto('items')
      .values({ name: "quote ' and ?", payload })
      .executeTakeFirstOrThrow();
    expect(inserted.insertId).toBe(1n);
    expect(inserted.numInsertedOrUpdatedRows).toBe(1n);
    expect(await db.selectFrom('items').selectAll().execute()).toEqual([
      { id: 1, name: "quote ' and ?", payload },
    ]);

    const updated = await db
      .updateTable('items')
      .set({ payload: null })
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(updated.numUpdatedRows).toBe(1n);
    expect(await db.selectFrom('items').select('payload').executeTakeFirstOrThrow()).toEqual({
      payload: null,
    });
    const deleted = await db.deleteFrom('items').where('id', '=', 1).executeTakeFirstOrThrow();
    expect(deleted.numDeletedRows).toBe(1n);
    expect(await db.selectFrom('items').selectAll().execute()).toEqual([]);
  });

  it('returns rows from INSERT, UPDATE and DELETE RETURNING', async () => {
    expect(
      await db
        .insertInto('items')
        .values({ name: 'first' })
        .returningAll()
        .executeTakeFirstOrThrow()
    ).toEqual({ id: 1, name: 'first', payload: null });
    expect(
      await db.updateTable('items').set({ name: 'second' }).returningAll().executeTakeFirstOrThrow()
    ).toEqual({ id: 1, name: 'second', payload: null });
    expect(await db.deleteFrom('items').returning('id').execute()).toEqual([{ id: 1 }]);
  });

  it('commits successful transactions and rolls back rejected ones', async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('items').values({ name: 'committed' }).execute();
    });
    const failure = new Error('intentional rollback');
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('items').values({ name: 'rolled back' }).execute();
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(await db.selectFrom('items').select('name').execute()).toEqual([{ name: 'committed' }]);
  });

  it('queues concurrent work until a transaction rolls back', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('release connection after rollback');
    const transaction = db.transaction().execute(async (trx) => {
      await trx.insertInto('items').values({ name: 'rolled back' }).execute();
      entered.resolve();
      await release.promise;
      throw failure;
    });
    // Attach the rejection handler before allowing the transaction to reject.
    const rejected = transaction.catch((error: unknown) => error);
    await entered.promise;
    const outside = db.insertInto('items').values({ name: 'outside transaction' }).execute();
    // Let the competing query reach acquisition while the transaction is held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    const [reason] = await Promise.all([rejected, outside]);
    expect(reason).toBe(failure);
    expect(await db.selectFrom('items').select('name').execute()).toEqual([
      { name: 'outside transaction' },
    ]);
  });

  it('supports savepoint rollback through the Kysely driver', async () => {
    const trx = await db.startTransaction().execute();
    try {
      await trx.insertInto('items').values({ name: 'kept' }).execute();
      const checkpoint = await trx.savepoint('checkpoint').execute();
      await checkpoint.insertInto('items').values({ name: 'discarded' }).execute();
      await checkpoint.rollbackToSavepoint('checkpoint').execute();
      await checkpoint.releaseSavepoint('checkpoint').execute();
      await trx.commit().execute();
    } finally {
      if (!trx.isCommitted && !trx.isRolledBack) await trx.rollback().execute();
    }
    expect(await db.selectFrom('items').select('name').execute()).toEqual([{ name: 'kept' }]);
  });

  it('streams bound SELECTs and releases the connection after early exit', async () => {
    await db
      .insertInto('items')
      .values([{ name: 'first' }, { name: 'second' }])
      .execute();
    const names: string[] = [];
    for await (const row of db
      .selectFrom('items')
      .selectAll()
      .where('id', '>', 0)
      .orderBy('id')
      .stream()) {
      names.push(row.name);
    }
    expect(names).toEqual(['first', 'second']);
    for await (const row of db.selectFrom('items').selectAll().orderBy('id').stream()) {
      expect(row.name).toBe('first');
      break;
    }
    await db.insertInto('items').values({ name: 'after stream' }).execute();
    expect(
      await db.selectFrom('items').select('name').where('id', '=', 3).executeTakeFirstOrThrow()
    ).toEqual({
      name: 'after stream',
    });
  });

  it('releases the connection after a constraint error', async () => {
    await db.insertInto('items').values({ name: 'unique' }).execute();
    await expect(db.insertInto('items').values({ name: 'unique' }).execute()).rejects.toThrow(
      'UNIQUE constraint failed: items.name'
    );
    await db.insertInto('items').values({ name: 'usable' }).execute();
    expect(await db.selectFrom('items').select('name').orderBy('id').execute()).toEqual([
      { name: 'unique' },
      { name: 'usable' },
    ]);
  });

  it('supports introspection and closes the underlying database on destroy', async () => {
    const tables = await db.introspection.getTables();
    expect(
      tables.find((table) => table.name === 'items')?.columns.map((column) => column.name)
    ).toEqual(['id', 'name', 'payload']);
    expect((await sql<{ value: number }>`select 42 as value`.execute(db)).rows).toEqual([
      { value: 42 },
    ]);
    await db.destroy();
    expect(() => sqlite.prepare('select 1')).toThrow('closed');
  });
});
