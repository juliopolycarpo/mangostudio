/**
 * The hub commits at `synchronous = NORMAL` once its migrations are done, and a
 * write that records an intent before an irreversible step commits at `FULL`.
 * These tests read `PRAGMA synchronous` from the connection itself, after each
 * statement, so the order is observed rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Kysely, sql } from 'kysely';

import { type PragmaRunner, relaxDurability, runDurably } from '../../../src/db/durability';
import type { Database } from '../../../src/db/types';
import { runMigrations } from '../../../src/server/migrations';
import { DiagnosticWarnCapture } from '../../support/diagnostic-warn-capture';
import {
  ObservedFileDatabase,
  SYNCHRONOUS_FULL as FULL,
  SYNCHRONOUS_NORMAL as NORMAL,
} from '../../support/observed-file-database';

let directory: string;
let file: ObservedFileDatabase;

/** Named fake for the connection's pragma surface, with the journal mode it will report. */
class FakePragmaRunner implements PragmaRunner {
  readonly statementsRun: string[] = [];

  constructor(private readonly journalMode: string | undefined) {}

  read(statement: string): Promise<string | undefined> {
    return Promise.resolve(statement === 'journal_mode' ? this.journalMode : undefined);
  }

  run(statement: string): Promise<void> {
    this.statementsRun.push(statement);
    return Promise.resolve();
  }
}

const pragmaStatements = () =>
  file.observed.filter((entry) => /PRAGMA synchronous/i.test(entry.sql));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'durability-'));
});

afterEach(async () => {
  await file?.destroy();
  rmSync(directory, { recursive: true, force: true });
});

describe('relaxDurability', () => {
  it('lowers a connection that is in WAL mode from FULL to NORMAL', async () => {
    file = new ObservedFileDatabase(directory);
    expect(file.level()).toBe(FULL);

    const outcome = await relaxDurability(file.db);

    expect({ outcome, synchronous: file.level() }).toEqual({
      outcome: 'normal',
      synchronous: NORMAL,
    });
  });

  it('keeps FULL and warns once when the journal mode is not wal', async () => {
    file = new ObservedFileDatabase(directory, { applyPragmas: false });
    const runner = new FakePragmaRunner('delete');

    let outcome: string | undefined;
    const warnings = await new DiagnosticWarnCapture().during(async () => {
      outcome = await relaxDurability(file.db, runner);
    });

    expect({ outcome, statementsRun: runner.statementsRun, warnings: warnings.length }).toEqual({
      outcome: 'full',
      statementsRun: [],
      warnings: 1,
    });
    expect(warnings[0]).toContain('synchronous_kept_full');
  });

  it('keeps FULL without a warning for an in-memory database', async () => {
    file = new ObservedFileDatabase(directory, { applyPragmas: false });
    const runner = new FakePragmaRunner('memory');

    let outcome: string | undefined;
    const warnings = await new DiagnosticWarnCapture().during(async () => {
      outcome = await relaxDurability(file.db, runner);
    });

    expect({ outcome, statementsRun: runner.statementsRun, warnings }).toEqual({
      outcome: 'full',
      statementsRun: [],
      warnings: [],
    });
  });

  it('leaves a real file database whose journal mode is not wal at FULL', async () => {
    file = new ObservedFileDatabase(directory, { applyPragmas: false });

    let outcome: string | undefined;
    await new DiagnosticWarnCapture().during(async () => {
      outcome = await relaxDurability(file.db);
    });

    expect({ outcome, synchronous: file.level() }).toEqual({ outcome: 'full', synchronous: FULL });
  });
});

describe('runDurably', () => {
  const readLevel = async (conn: Kysely<Database>): Promise<number> => {
    const { rows } = await sql<{ synchronous: number }>`PRAGMA synchronous`.execute(conn);
    return rows[0]?.synchronous ?? -1;
  };

  it('commits at FULL, including a transaction opened inside, and restores NORMAL', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    await sql`CREATE TABLE marker (v TEXT)`.execute(file.db);

    const seen = await runDurably(file.db, async (conn) => {
      const before = await readLevel(conn);
      const inTransaction = await conn.transaction().execute(async (trx) => {
        await sql`INSERT INTO marker VALUES ('written')`.execute(trx);
        return file.level();
      });
      return { before, inTransaction };
    });

    expect({ ...seen, after: file.level() }).toEqual({
      before: FULL,
      inTransaction: FULL,
      after: NORMAL,
    });
  });

  it('restores NORMAL and rethrows the error of work that fails', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);

    const failure = new Error('expected failure from the durable work');
    const outcome = await runDurably(file.db, () => Promise.reject(failure)).catch(
      (error: unknown) => error
    );

    expect({ outcome, synchronous: file.level() }).toEqual({
      outcome: failure,
      synchronous: NORMAL,
    });
  });

  it('runs work without touching the pragma on a connection that is already at FULL', async () => {
    file = new ObservedFileDatabase(directory);
    // Never relaxed: the baseline is FULL, so there is nothing to raise.

    await runDurably(file.db, (conn) => sql`SELECT 1`.execute(conn));

    expect({ pragmaStatements: pragmaStatements().length, synchronous: file.level() }).toEqual({
      pragmaStatements: 0,
      synchronous: FULL,
    });
  });

  it('does not raise a database that stayed at FULL because it is not in WAL mode', async () => {
    file = new ObservedFileDatabase(directory, { applyPragmas: false });
    await new DiagnosticWarnCapture().during(() => relaxDurability(file.db));

    await runDurably(file.db, (conn) => sql`SELECT 1`.execute(conn));

    expect({ pragmaStatements: pragmaStatements().length, synchronous: file.level() }).toEqual({
      pragmaStatements: 0,
      synchronous: FULL,
    });
  });

  it('runs inside a caller transaction as is, because SQLite cannot change the level there', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    const before = pragmaStatements().length;

    const seen = await file.db
      .transaction()
      .execute((trx) => runDurably(trx, () => Promise.resolve(file.level())));

    expect({ seen, newPragmaStatements: pragmaStatements().length - before }).toEqual({
      seen: NORMAL,
      newPragmaStatements: 0,
    });
  });
});

describe('runMigrations', () => {
  it('applies every migration at FULL and lowers to NORMAL only after they finish', async () => {
    file = new ObservedFileDatabase(directory);

    await runMigrations(file.db);

    const lowering = file.observed.findIndex((entry) =>
      /PRAGMA synchronous = NORMAL/i.test(entry.sql)
    );
    const duringMigrations = file.observed.slice(0, lowering);
    expect({
      lowered: lowering > 0,
      migrationStatements: duringMigrations.length > 100,
      everyMigrationStatementAtFull: duringMigrations.every((entry) => entry.synchronous === FULL),
      finalLevel: file.level(),
    }).toEqual({
      lowered: true,
      migrationStatements: true,
      everyMigrationStatementAtFull: true,
      finalLevel: NORMAL,
    });
  }, 60_000);
});
