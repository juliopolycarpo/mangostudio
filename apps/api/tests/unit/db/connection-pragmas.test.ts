/**
 * A file database opens in WAL mode at `synchronous = FULL`, whatever the SQLite
 * build defaults to; the hub lowers it after its migrations (see `durability.test.ts`).
 */
import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyConnectionPragmas } from '../../../src/db/database';
import { removeFixtureDirSync } from '../../support/remove-fixture-dir';

/** `PRAGMA synchronous` answers with the numeric level: 0 off, 1 normal, 2 full, 3 extra. */
const SYNCHRONOUS_OFF = 0;
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
  removeFixtureDirSync({ role: 'connection-pragmas', path: directory });
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

  it.each([
    ['NORMAL', 'NORMAL', SYNCHRONOUS_NORMAL],
    ['OFF', 'OFF', SYNCHRONOUS_OFF],
  ])(
    'brings a file database that starts at %s up to FULL, as a build whose WAL default is lower does',
    (_name, startingPragma, startingLevel) => {
      // Apple's SQLite lowers a connection to NORMAL when it enters WAL mode. Forcing the
      // lower level first reproduces that on a build whose default is FULL.
      const path = join(directory, 'database.sqlite');
      sqlite = new SQLiteDatabase(path);
      sqlite.exec(`PRAGMA synchronous = ${startingPragma}`);
      expect(pragma('synchronous')).toBe(startingLevel);

      applyConnectionPragmas(sqlite, path);

      expect({ journalMode: pragma('journal_mode'), synchronous: pragma('synchronous') }).toEqual({
        journalMode: 'wal',
        synchronous: SYNCHRONOUS_FULL,
      });
    }
  );

  it('sets FULL after the WAL switch, so a build that lowers the level on that switch cannot undo it', () => {
    const path = join(directory, 'database.sqlite');
    sqlite = new SQLiteDatabase(path);
    const statements: string[] = [];
    const exec = sqlite.exec.bind(sqlite);
    sqlite.exec = (statement: string) => {
      statements.push(statement);
      return exec(statement);
    };

    applyConnectionPragmas(sqlite, path);

    const walSwitch = statements.findIndex((statement) =>
      /journal_mode\s*=\s*WAL/i.test(statement)
    );
    const fullLevel = statements.findIndex((statement) =>
      /synchronous\s*=\s*FULL/i.test(statement)
    );
    expect(
      { walSwitch: walSwitch >= 0, fullAfterSwitch: fullLevel > walSwitch },
      `expected PRAGMA synchronous = FULL after journal_mode = WAL | received: ${statements.join(' ')}`
    ).toEqual({ walSwitch: true, fullAfterSwitch: true });
  });

  it('leaves an in-memory database out of WAL and at FULL', () => {
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

  // Open handles are listed through /proc, so the check runs where that exists. Windows, where
  // an open handle blocks deleting the file, is covered by the native qualification run.
  it.skipIf(process.platform !== 'linux')(
    'closeDb releases the database file even when no query ever ran',
    () => {
      const script = `
        import { readdirSync, readlinkSync } from 'node:fs';
        import { loadConfigForTest } from './src/lib/config';
        import { closeDb, getDb } from './src/db/database';
        const path = process.env.CONNECTION_PRAGMAS_DB_PATH;
        loadConfigForTest({ database: { path } });
        const handles = () =>
          readdirSync('/proc/self/fd').filter((fd) => {
            try { return readlinkSync('/proc/self/fd/' + fd).startsWith(path); } catch { return false; }
          }).length;
        getDb();
        const open = handles();
        await closeDb();
        console.log('RESULT ' + JSON.stringify({ open, closed: handles() }));
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
      const { open, closed } = JSON.parse(line?.slice('RESULT '.length) ?? '{}') as {
        open: number;
        closed: number;
      };
      expect(
        { opened: open > 0, handlesAfterCloseDb: closed },
        `expected the file open after getDb and 0 handles after closeDb | received: ${line}`
      ).toEqual({ opened: true, handlesAfterCloseDb: 0 });
    },
    60_000
  );
});
