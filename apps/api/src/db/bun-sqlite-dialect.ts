import type { Database, SQLQueryBindings } from 'bun:sqlite';

import { type DialectAdapter, SqliteAdapter, SqliteDialect } from 'kysely';

/**
 * Kysely's stock SQLite adapter reports `supportsTransactionalDdl = false`, so its
 * `Migrator` runs every migration statement in autocommit: one fsync per statement
 * at `synchronous = FULL`, and a crash can leave DDL applied without its
 * `kysely_migration` row. SQLite does support transactional DDL, so this adapter
 * says so, and `migrateToLatest` then applies the whole pending batch, bookkeeping
 * rows included, in one transaction that commits in full or not at all.
 *
 * A migration therefore must reach the database only through the `db` it is given:
 * the driver serialises one connection, and a second handle (`getDb()`, a raw
 * `bun:sqlite` handle) would wait on the connection the batch holds. It also must
 * not toggle `PRAGMA foreign_keys` or `synchronous`, which SQLite ignores inside a
 * transaction, or run `VACUUM`, which it refuses there.
 */
class TransactionalDdlSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

/** The stock SQLite dialect with {@link TransactionalDdlSqliteAdapter} swapped in. */
class BunSqliteDialect extends SqliteDialect {
  override createAdapter(): DialectAdapter {
    return new TransactionalDdlSqliteAdapter();
  }
}

/**
 * Adapt Bun statements to Kysely's SQLite driver, which owns transaction locking.
 * Destroying the Kysely instance closes the supplied database. Every Kysely built
 * from this dialect migrates in one transaction (see {@link TransactionalDdlSqliteAdapter}).
 *
 * @example
 * const db = new Kysely<AppDatabase>({ dialect: createBunSqliteDialect(sqlite) });
 */
export function createBunSqliteDialect(sqlite: Database): SqliteDialect {
  return new BunSqliteDialect({
    database: {
      // Finalize prepared statements so the database file is released on destroy.
      close: () => sqlite.close(true),
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        return {
          reader: statement.columnNames.length > 0,
          // Kysely exposes bindings as unknown; Bun validates their SQLite types.
          all: (parameters) => statement.all(...(parameters as SQLQueryBindings[])),
          run: (parameters) => statement.run(...(parameters as SQLQueryBindings[])),
          iterate: (parameters) => statement.iterate(...(parameters as SQLQueryBindings[])),
        };
      },
    },
  });
}
