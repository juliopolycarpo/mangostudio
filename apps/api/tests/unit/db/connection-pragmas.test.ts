/**
 * A file database opens in WAL mode at SQLite's default `synchronous = FULL`;
 * the hub lowers it after its migrations (see `durability.test.ts`).
 */
import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyConnectionPragmas } from '../../../src/db/database';

/** `PRAGMA synchronous` answers with the numeric level: 0 off, 1 normal, 2 full, 3 extra. */
const SYNCHRONOUS_NORMAL = 1;
const SYNCHRONOUS_FULL = 2;

const API_ROOT = join(import.meta.dir, '..', '..', '..');

let directory: string;
let sqlite: SQLiteDatabase | undefined;

const pragma = (name: string): unknown => {
  const row = sqlite?.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  return row ? Object.values(row)[0] : undefined;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'connection-pragmas-'));
});

afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe('applyConnectionPragmas', () => {
  it('opens a file database in WAL mode with foreign keys on, still syncing every commit', () => {
    const path = join(directory, 'database.sqlite');
    sqlite = new SQLiteDatabase(path);

    applyConnectionPragmas(sqlite, path);

    expect({
      journalMode: pragma('journal_mode'),
      synchronous: pragma('synchronous'),
      foreignKeys: pragma('foreign_keys'),
    }).toEqual({ journalMode: 'wal', synchronous: SYNCHRONOUS_FULL, foreignKeys: 1 });
  });

  it('leaves an in-memory database out of WAL and at the default synchronous level', () => {
    sqlite = new SQLiteDatabase(':memory:');

    applyConnectionPragmas(sqlite, ':memory:');

    expect({
      journalMode: pragma('journal_mode'),
      synchronous: pragma('synchronous'),
      foreignKeys: pragma('foreign_keys'),
    }).toEqual({ journalMode: 'memory', synchronous: SYNCHRONOUS_FULL, foreignKeys: 1 });
  });

  it('keeps the data a reopened file database committed', () => {
    const path = join(directory, 'database.sqlite');
    sqlite = new SQLiteDatabase(path);
    applyConnectionPragmas(sqlite, path);
    sqlite.exec('CREATE TABLE t (v TEXT)');
    sqlite.exec("INSERT INTO t VALUES ('committed')");
    sqlite.close();

    sqlite = new SQLiteDatabase(path);

    expect(sqlite.query('SELECT v FROM t').get()).toEqual({ v: 'committed' });
  });
});

describe('getDb on a file database', () => {
  it('opens in WAL at FULL, and runMigrations lowers it to NORMAL', () => {
    // A child process: `getDb()` is a process-wide singleton the other tests share.
    const script = `
      import { sql } from 'kysely';
      import { loadConfigForTest } from './src/lib/config';
      import { getDb } from './src/db/database';
      import { runMigrations } from './src/server/migrations';
      loadConfigForTest({ database: { path: process.env.CONNECTION_PRAGMAS_DB_PATH } });
      const read = async (name) =>
        Object.values((await sql.raw('PRAGMA ' + name).execute(getDb())).rows[0])[0];
      const before = { journalMode: await read('journal_mode'), synchronous: await read('synchronous') };
      await runMigrations();
      const after = { synchronous: await read('synchronous') };
      console.log('RESULT ' + JSON.stringify({ before, after }));
    `;

    const child = Bun.spawnSync(['bun', '-e', script], {
      cwd: API_ROOT,
      env: { ...process.env, CONNECTION_PRAGMAS_DB_PATH: join(directory, 'hub.sqlite') },
    });

    const output = child.stdout.toString();
    const line = output.split('\n').find((candidate) => candidate.startsWith('RESULT '));
    expect(
      line,
      `expected a RESULT line | received exit ${child.exitCode}: ${output} ${child.stderr.toString()}`
    ).toBeDefined();
    expect(JSON.parse(line?.slice('RESULT '.length) ?? '{}')).toEqual({
      before: { journalMode: 'wal', synchronous: SYNCHRONOUS_FULL },
      after: { synchronous: SYNCHRONOUS_NORMAL },
    });
  }, 60_000);
});
