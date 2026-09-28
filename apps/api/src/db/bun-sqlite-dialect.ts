import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { SqliteDialect } from 'kysely';

/**
 * Adapt Bun statements to Kysely's SQLite driver, which owns transaction locking.
 * Destroying the Kysely instance closes the supplied database.
 *
 * @example
 * const db = new Kysely<AppDatabase>({ dialect: createBunSqliteDialect(sqlite) });
 */
export function createBunSqliteDialect(sqlite: Database): SqliteDialect {
  return new SqliteDialect({
    database: {
      close: () => sqlite.close(),
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
