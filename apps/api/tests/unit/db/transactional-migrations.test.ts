import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kysely, sql } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { applyConnectionPragmas } from '../../../src/db/database';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';
import { removeFixtureDir } from '../../support/remove-fixture-dir';

const INJECTED_FAILURE = 'injected failure: fake migration 003 refuses to run';

/** Creates the named table, so a test can see whether the DDL survived. */
function createsTable(table: string): Migration {
  return {
    async up(db) {
      await db.schema.createTable(table).addColumn('id', 'integer').execute();
    },
  };
}

/**
 * Three-step fake set. Migrations 001 and 002 create tables; 003 creates its own
 * table and then throws when `failThird` is set, so the failure lands after DDL
 * that already ran in the same batch.
 */
function fakeMigrationSet(options: { failThird: boolean }): MigrationProvider {
  return {
    getMigrations: () =>
      Promise.resolve({
        '001_fake_alpha': createsTable('fake_alpha'),
        '002_fake_beta': createsTable('fake_beta'),
        '003_fake_gamma': {
          async up(db) {
            await db.schema.createTable('fake_gamma').addColumn('id', 'integer').execute();
            if (options.failThird) throw new Error(INJECTED_FAILURE);
          },
        },
      }),
  };
}

/** Fake set limited to its first `count` migrations, to stop a database at an older point. */
function fakeMigrationPrefix(count: number): MigrationProvider {
  return {
    async getMigrations() {
      const all = await fakeMigrationSet({ failThird: false }).getMigrations();
      return Object.fromEntries(Object.entries(all).slice(0, count));
    },
  };
}

async function tableNames<DB>(db: Kysely<DB>): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fake_%' ORDER BY name`.execute(
    db
  );
  return rows.map(({ name }) => name);
}

async function recordedMigrations<DB>(db: Kysely<DB>): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
  return rows.map(({ name }) => name);
}

const ALLOWED_MIGRATION_MODULES = new Set(['kysely', 'kysely/migration']);

/**
 * Module references in a migration source other than Kysely: static imports in either
 * quote style, side-effect imports, and any dynamic `import(` or `require(`, whose target
 * a text scan cannot resolve and so counts as stray. Block comments and whole-line `//`
 * comments are dropped first: prose such as `moves from "reads only" to ...` is not an import.
 */
function strayModuleReferences(rawSource: string): string[] {
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const staticSpecifiers = [...source.matchAll(/(?:\bfrom\s*|^\s*import\s+)(["'])([^"']+)\1/gm)]
    .map((match) => match[2])
    .filter((specifier): specifier is string => specifier !== undefined)
    .filter((specifier) => !ALLOWED_MIGRATION_MODULES.has(specifier));
  const dynamic = [
    /\bimport\s*\(/.test(source) ? 'import(...)' : undefined,
    /\brequire\s*\(/.test(source) ? 'require(...)' : undefined,
  ].filter((reference): reference is string => reference !== undefined);
  return [...staticSpecifiers, ...dynamic];
}

/**
 * Fails with a named message when `work` is still pending after `milliseconds`, so a
 * migration that waits on a connection the batch already holds fails the test instead of
 * hanging the lane.
 */
async function finishesWithin<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `expected the migration batch to finish within ${milliseconds}ms | received: still running; a migration may be reaching a second connection`
        )
      );
    }, milliseconds);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describe('transactional SQLite migrations', () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = new Kysely<unknown>({ dialect: createBunSqliteDialect(new SQLiteDatabase(':memory:')) });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('reports transactional DDL on the adapter every Bun SQLite Kysely gets', () => {
    expect({
      supportsTransactionalDdl: db.getExecutor().adapter.supportsTransactionalDdl,
    }).toEqual({ supportsTransactionalDdl: true });
  });

  it('records every migration of a successful batch', async () => {
    const { error, results } = await new Migrator({
      db,
      provider: fakeMigrationSet({ failThird: false }),
    }).migrateToLatest();

    expect(error).toBeUndefined();
    expect(results?.map(({ migrationName, status }) => `${migrationName}:${status}`)).toEqual([
      '001_fake_alpha:Success',
      '002_fake_beta:Success',
      '003_fake_gamma:Success',
    ]);
    expect({
      tables: await tableNames(db),
      recorded: await recordedMigrations(db),
    }).toEqual({
      tables: ['fake_alpha', 'fake_beta', 'fake_gamma'],
      recorded: ['001_fake_alpha', '002_fake_beta', '003_fake_gamma'],
    });
  });

  it('rolls back the whole batch when a later migration fails', async () => {
    const { error } = await new Migrator({
      db,
      provider: fakeMigrationSet({ failThird: true }),
    }).migrateToLatest();

    expect(error instanceof Error ? error.message : String(error)).toBe(INJECTED_FAILURE);
    // 001 and 002 ran to completion before 003 threw; none of it may persist.
    expect({
      tables: await tableNames(db),
      recorded: await recordedMigrations(db),
    }).toEqual({ tables: [], recorded: [] });
  });

  it('names a migration that waits on the connection the batch holds instead of hanging', async () => {
    // The outer handle shares the one connection the batch transaction holds, so a query
    // through it queues behind the transaction that is waiting on this very migration.
    const reachesOuterConnection: MigrationProvider = {
      getMigrations: () =>
        Promise.resolve({
          '001_fake_deadlock': {
            async up() {
              await sql`SELECT 1`.execute(db);
            },
          },
        }),
    };

    await expect(
      finishesWithin(new Migrator({ db, provider: reachesOuterConnection }).migrateToLatest(), 500)
    ).rejects.toThrow(
      'expected the migration batch to finish within 500ms | received: still running; a migration may be reaching a second connection'
    );
  });

  it('keeps an earlier committed batch when only the next batch fails', async () => {
    const first = await new Migrator({ db, provider: fakeMigrationPrefix(1) }).migrateToLatest();
    expect(first.error).toBeUndefined();

    const { error } = await new Migrator({
      db,
      provider: fakeMigrationSet({ failThird: true }),
    }).migrateToLatest();

    expect(error instanceof Error ? error.message : String(error)).toBe(INJECTED_FAILURE);
    expect({
      tables: await tableNames(db),
      recorded: await recordedMigrations(db),
    }).toEqual({ tables: ['fake_alpha'], recorded: ['001_fake_alpha'] });
  });
});

describe('migration sources inside the batch transaction', () => {
  it('import nothing that could open a second connection to the hub database', async () => {
    const migrationsDirectory = join(import.meta.dir, '../../../src/db/migrations');
    const offenders: string[] = [];
    for await (const file of new Bun.Glob('*.ts').scan(migrationsDirectory)) {
      if (file === 'index.ts') continue;
      const source = await Bun.file(join(migrationsDirectory, file)).text();
      const stray = strayModuleReferences(source);
      if (stray.length > 0 || /\bgetDb\b|bun:sqlite/.test(source)) {
        offenders.push(`${file} (references: ${stray.join(', ') || 'none'})`);
      }
    }
    // The driver serialises one connection; a migration that reached the singleton or a raw
    // handle would wait on the connection the batch transaction holds and deadlock.
    expect({ offenders }).toEqual({ offenders: [] });
  });

  it('flags double-quoted, side-effect, dynamic and require references the scan could miss', () => {
    const source = [
      `import type { Migration } from 'kysely/migration';`,
      `import { getDb } from "../database";`,
      `import '../side-effect';`,
      `const lazy = await import(path);`,
      `const legacy = require('node:fs');`,
      `/** An account whose default moves from "reads only" to "everything". */`,
      `// import { ignored } from "../commented-out";`,
    ].join('\n');
    expect(strayModuleReferences(source)).toEqual([
      '../database',
      '../side-effect',
      'import(...)',
      'require(...)',
    ]);
  });
});

describe('upgrading an older file database in one transaction', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mango-transactional-migrations-'));
  });

  afterEach(async () => {
    await removeFixtureDir({ role: 'transactional-migrations', path: directory });
  });

  /** Opens the file the way the hub does: WAL, `synchronous = FULL`, foreign keys on. */
  function openHubDatabase(path: string): Kysely<Database> {
    const sqlite = new SQLiteDatabase(path);
    applyConnectionPragmas(sqlite, path);
    return new Kysely<Database>({ dialect: createBunSqliteDialect(sqlite) });
  }

  it('applies migrations 061 to the latest on top of a database stopped at 060', async () => {
    const path = join(directory, 'hub.sqlite');
    const olderMigrations = Object.fromEntries(
      Object.entries(allMigrations).filter(([name]) => name <= '060_product_operations')
    );
    const latestName = Object.keys(allMigrations).sort().at(-1);

    const older = openHubDatabase(path);
    try {
      const { error } = await new Migrator({
        db: older,
        provider: { getMigrations: () => Promise.resolve(olderMigrations) },
      }).migrateToLatest();
      expect(error).toBeUndefined();
      await older
        .insertInto('environments')
        .values({
          id: 'box-1',
          userId: 'owner',
          name: 'box-1',
          transportKind: 'stdio',
          configJson: '{}',
          enabled: 1,
          allowInstalls: 0,
          createdAt: 1,
          updatedAt: 1,
        })
        .execute();
    } finally {
      await older.destroy();
    }

    const upgraded = openHubDatabase(path);
    try {
      const { error, results } = await finishesWithin(
        new Migrator({
          db: upgraded,
          provider: { getMigrations: () => Promise.resolve(allMigrations) },
        }).migrateToLatest(),
        10_000
      );

      expect(error).toBeUndefined();
      expect(results?.every(({ status }) => status === 'Success')).toBe(true);
      const recorded = await recordedMigrations(upgraded);
      expect({ count: recorded.length, last: recorded.at(-1) }).toEqual({
        count: Object.keys(allMigrations).length,
        last: latestName,
      });
      const environment = await upgraded
        .selectFrom('environments')
        .select('toolchainRevision')
        .executeTakeFirstOrThrow();
      expect(environment.toolchainRevision).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      await upgraded.destroy();
    }
  });
});
