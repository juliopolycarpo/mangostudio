import { Database as SQLiteDatabase } from 'bun:sqlite';
import { join } from 'node:path';

import { Kysely } from 'kysely';

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
 * A file database opened the way `getDb()` opens one, that records the
 * connection's `synchronous` level after every statement Kysely runs. It lets a
 * test see which level a particular write committed at, instead of inferring it.
 */
export class ObservedFileDatabase {
  readonly sqlite: SQLiteDatabase;
  readonly db: Kysely<Database>;
  readonly observed: ObservedStatement[] = [];

  constructor(directory: string, options: { applyPragmas: boolean } = { applyPragmas: true }) {
    const path = join(directory, 'database.sqlite');
    this.sqlite = new SQLiteDatabase(path);
    if (options.applyPragmas) applyConnectionPragmas(this.sqlite, path);
    this.db = new Kysely<Database>({
      dialect: createBunSqliteDialect(this.sqlite),
      log: (event) => {
        this.observed.push({ sql: event.query.sql, synchronous: this.level() });
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

  destroy(): Promise<void> {
    return this.db.destroy();
  }
}
