import { Database as SQLiteDatabase } from 'bun:sqlite';
import { join } from 'node:path';

import {
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  type TransactionSettings,
} from 'kysely';

import { createBunSqliteDialect } from '../../src/db/bun-sqlite-dialect';
import { applyConnectionPragmas } from '../../src/db/database';
import type { Database } from '../../src/db/types';

/** `PRAGMA synchronous` answers with the numeric level. */
export const SYNCHRONOUS_NORMAL = 1;
export const SYNCHRONOUS_FULL = 2;

export interface ObservedStatement {
  readonly sql: string;
  /** The connection's `synchronous` level right after the statement ran. */
  readonly synchronous: number;
}

/**
 * A driver that wakes the next waiter on a later macrotask after the connection is
 * released, and tells the test the moment it is free. Kysely's own lock behaves the
 * same way in miniature (a caller that arrives just as the connection is released
 * overtakes a waiter that was already queued); this fake widens that gap so a test
 * can open a second user of the connection inside it without depending on microtask
 * timing.
 */
class SlowHandoffDriver implements Driver {
  private busy = false;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly inner: Driver,
    private readonly onReleased: () => void
  ) {}

  init(): Promise<void> {
    return this.inner.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    while (this.busy) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.busy = true;
    return this.inner.acquireConnection();
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    await this.inner.releaseConnection(connection);
    this.busy = false;
    this.onReleased();
    const next = this.waiters.shift();
    if (next) setTimeout(next, 0);
  }

  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    return this.inner.beginTransaction(connection, settings);
  }

  commitTransaction(connection: DatabaseConnection): Promise<void> {
    return this.inner.commitTransaction(connection);
  }

  rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    return this.inner.rollbackTransaction(connection);
  }

  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

/**
 * A file database opened the way `getDb()` opens one, that records the
 * connection's `synchronous` level after every statement Kysely runs. It lets a
 * test see which level a particular write committed at, instead of inferring it.
 */
export class ObservedFileDatabase {
  readonly sqlite: SQLiteDatabase;
  readonly db: Kysely<Database>;
  readonly observed: ObservedStatement[] = [];
  private failing: { readonly pattern: RegExp; readonly error: Error } | null = null;
  private afterRelease: (() => void) | null = null;

  constructor(directory: string, options: { applyPragmas?: boolean; slowHandoff?: boolean } = {}) {
    const path = join(directory, 'database.sqlite');
    this.sqlite = new SQLiteDatabase(path);
    if (options.applyPragmas !== false) applyConnectionPragmas(this.sqlite, path);
    const dialect = createBunSqliteDialect(this.failingOnRequest(this.sqlite));
    this.db = new Kysely<Database>({
      dialect: options.slowHandoff ? this.withSlowHandoff(dialect) : dialect,
      log: (event) => {
        this.observed.push({ sql: event.query.sql, synchronous: this.level() });
      },
    });
  }

  /**
   * Runs `callback` synchronously the next time the connection is released, before the
   * next waiter is woken. Needs `slowHandoff`.
   */
  afterNextRelease(callback: () => void): void {
    this.afterRelease = callback;
  }

  private withSlowHandoff(dialect: Dialect): Dialect {
    return {
      // Kysely serializes a single-connection adapter in its own lock, above the driver.
      // Claiming several connections turns that lock off, so this driver's queue is the
      // only one and its wake-up order is the one the test sees.
      createAdapter: () => {
        const adapter = dialect.createAdapter();
        return new Proxy(adapter, {
          get: (target, property) => {
            if (property === 'supportsMultipleConnections') return true;
            const value = Reflect.get(target, property) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      createDriver: () =>
        new SlowHandoffDriver(dialect.createDriver(), () => {
          const callback = this.afterRelease;
          this.afterRelease = null;
          callback?.();
        }),
      createIntrospector: (db) => dialect.createIntrospector(db),
      createQueryCompiler: () => dialect.createQueryCompiler(),
    };
  }

  /** Makes the next statement matching `pattern` throw `error` instead of running. */
  failNextStatement(pattern: RegExp, error: Error): void {
    this.failing = { pattern, error };
  }

  /** Wraps the connection so a statement armed with {@link failNextStatement} throws when prepared. */
  private failingOnRequest(sqlite: SQLiteDatabase): SQLiteDatabase {
    return new Proxy(sqlite, {
      get: (target, property) => {
        if (property === 'prepare') {
          return (statement: string) => {
            if (this.failing?.pattern.test(statement)) {
              const { error } = this.failing;
              this.failing = null;
              throw error;
            }
            return target.prepare(statement);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  level(): number {
    return (this.sqlite.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
  }

  /** The level the first statement matching `pattern` committed at, or undefined if none ran. */
  levelOf(pattern: RegExp): number | undefined {
    return this.observed.find((entry) => pattern.test(entry.sql))?.synchronous;
  }

  /** Forgets what ran so far, so a test can look only at the statements after this point. */
  forget(): void {
    this.observed.length = 0;
  }

  /**
   * Closes the database file. Kysely opens the driver on the first query only, so a test
   * that never ran one leaves `destroy()` with nothing to close, and the handle would keep
   * the file locked: Windows refuses to delete a directory that holds it.
   */
  async destroy(): Promise<void> {
    await this.db.destroy();
    this.sqlite.close(true);
  }
}
