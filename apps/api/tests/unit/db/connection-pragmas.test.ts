/**
 * The hub's file database runs WAL with `synchronous = NORMAL`: commits stop
 * paying an fsync each, and a power loss can drop the last few of them.
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
  it('opens a file database in WAL mode with synchronous NORMAL and foreign keys on', () => {
    const path = join(directory, 'database.sqlite');
    sqlite = new SQLiteDatabase(path);
    // A fresh connection starts at SQLite's default, FULL.
    expect(pragma('synchronous')).toBe(SYNCHRONOUS_FULL);

    applyConnectionPragmas(sqlite, path);

    expect({
      journalMode: pragma('journal_mode'),
      synchronous: pragma('synchronous'),
      foreignKeys: pragma('foreign_keys'),
    }).toEqual({ journalMode: 'wal', synchronous: SYNCHRONOUS_NORMAL, foreignKeys: 1 });
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

  it('keeps the data a reopened file database committed under synchronous NORMAL', () => {
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
