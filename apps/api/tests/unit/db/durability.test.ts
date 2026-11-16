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

import {
  type PragmaRunner,
  relaxDurability,
  runDurably,
  withFullDurability,
} from '../../../src/db/durability';
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

/** Statements that set the level; reading it back is not a change. */
const pragmaStatements = () =>
  file.observed.filter((entry) => /PRAGMA synchronous\s*=/i.test(entry.sql));

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

    const seen = await runDurably(file.db, 'durability_test_commit', async (conn) => {
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
    const outcome = await runDurably(file.db, 'durability_test_failure', () =>
      Promise.reject(failure)
    ).catch((error: unknown) => error);

    expect({ outcome, synchronous: file.level() }).toEqual({
      outcome: failure,
      synchronous: NORMAL,
    });
  });

  it('runs work without touching the pragma on a connection that is already at FULL', async () => {
    file = new ObservedFileDatabase(directory);
    // Never relaxed: the baseline is FULL, so there is nothing to raise.

    const warnings = await new DiagnosticWarnCapture().during(() =>
      runDurably(file.db, 'durability_test_unrelaxed', (conn) => sql`SELECT 1`.execute(conn))
    );

    expect({
      pragmaStatements: pragmaStatements().length,
      synchronous: file.level(),
      warnings,
    }).toEqual({ pragmaStatements: 0, synchronous: FULL, warnings: [] });
  });

  it('does not raise a database that stayed at FULL because it is not in WAL mode', async () => {
    file = new ObservedFileDatabase(directory, { applyPragmas: false });
    await new DiagnosticWarnCapture().during(() => relaxDurability(file.db));

    await new DiagnosticWarnCapture().during(() =>
      runDurably(file.db, 'durability_test_not_wal', (conn) => sql`SELECT 1`.execute(conn))
    );

    expect({ pragmaStatements: pragmaStatements().length, synchronous: file.level() }).toEqual({
      pragmaStatements: 0,
      synchronous: FULL,
    });
  });

  it('runs inside a caller transaction as is, because SQLite cannot change the level there', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    const before = pragmaStatements().length;

    let seen: number | undefined;
    await new DiagnosticWarnCapture().during(async () => {
      seen = await file.db
        .transaction()
        .execute((trx) =>
          runDurably(trx, 'durability_test_in_transaction', () => Promise.resolve(file.level()))
        );
    });

    expect({ seen, newPragmaStatements: pragmaStatements().length - before }).toEqual({
      seen: NORMAL,
      newPragmaStatements: 0,
    });
  });

  it('says so, once per label, when it is called inside a transaction on a relaxed database', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    const label = 'durability_test_loud_transaction';

    const warnings = await new DiagnosticWarnCapture().during(() =>
      file.db.transaction().execute(async (trx) => {
        await runDurably(trx, label, () => Promise.resolve());
        await runDurably(trx, label, () => Promise.resolve());
      })
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('durable_commit_not_raised');
    expect(warnings[0]).toContain(label);
    expect(warnings[0]).toContain('inside a transaction');
  });

  it('says so when it is called with a Kysely derived from the relaxed connection', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    const label = 'durability_test_loud_derived';

    const warnings = await new DiagnosticWarnCapture().during(() =>
      runDurably(file.db.withTables<Record<never, never>>(), label, () => Promise.resolve())
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(label);
    expect(warnings[0]).toContain('not the relaxed connection');
  });
});

describe('withFullDurability', () => {
  it('runs work that uses the shared connection at FULL and restores NORMAL', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);

    const seen = await withFullDurability(file.db, 'durability_test_window', async () => {
      await sql`SELECT 1`.execute(file.db);
      return file.level();
    });

    expect({ seen, after: file.level() }).toEqual({ seen: FULL, after: NORMAL });
  });

  it('keeps FULL until the last of two overlapping callers is done', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFullDurability(file.db, 'durability_test_first', () => firstMayFinish);
    const second = withFullDurability(file.db, 'durability_test_second', () => Promise.resolve());
    await second;
    const afterSecond = file.level();
    releaseFirst();
    await first;

    expect({ afterSecond, afterBoth: file.level() }).toEqual({
      afterSecond: FULL,
      afterBoth: NORMAL,
    });
  });

  it('restores NORMAL and rethrows when the work fails', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    const failure = new Error('expected failure from the windowed work');

    const outcome = await withFullDurability(file.db, 'durability_test_window_failure', () =>
      Promise.reject(failure)
    ).catch((error: unknown) => error);

    expect({ outcome, synchronous: file.level() }).toEqual({
      outcome: failure,
      synchronous: NORMAL,
    });
  });

  it('is not undone by a runDurably that finishes inside its window', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);

    const levelAfterInner = await withFullDurability(file.db, 'durability_test_outer', async () => {
      await runDurably(file.db, 'durability_test_inner', (conn) => sql`SELECT 1`.execute(conn));
      return file.level();
    });

    expect({ levelAfterInner, after: file.level() }).toEqual({
      levelAfterInner: FULL,
      after: NORMAL,
    });
  });

  it('says so, and changes nothing, inside a transaction on a relaxed database', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    const before = pragmaStatements().length;

    const warnings = await new DiagnosticWarnCapture().during(() =>
      file.db
        .transaction()
        .execute((trx) =>
          withFullDurability(trx, 'durability_test_window_in_transaction', () => Promise.resolve())
        )
    );

    expect({
      newPragmaStatements: pragmaStatements().length - before,
      warned: warnings.length,
    }).toEqual({
      newPragmaStatements: 0,
      warned: 1,
    });
  });

  it('does not touch the pragma on a connection that is at FULL', async () => {
    file = new ObservedFileDatabase(directory);

    await withFullDurability(file.db, 'durability_test_window_unrelaxed', () => Promise.resolve());

    expect(pragmaStatements()).toHaveLength(0);
  });
});

/** Holds the database's one connection, as a long running query would, until released. */
function holdConnection(db: Kysely<Database>) {
  let release: () => void = () => undefined;
  let acquired: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const done = db.connection().execute(async () => {
    acquired();
    await gate;
  });
  return { holding, release, done };
}

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('withFullDurability windows that close and open around a busy connection', () => {
  it('keeps FULL for a window that opens while the restore of the one before it is queued', async () => {
    // The connection is free for a moment before the queued restore wakes: the second
    // window's raise takes it in that gap, so the restore runs after the raise.
    file = new ObservedFileDatabase(directory, { slowHandoff: true });
    await relaxDurability(file.db);
    await sql`CREATE TABLE marker (v TEXT)`.execute(file.db);
    let finishFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let firstRaised: () => void = () => undefined;
    const raised = new Promise<void>((resolve) => {
      firstRaised = resolve;
    });
    const first = withFullDurability(file.db, 'durability_test_race_first', () => {
      firstRaised();
      return firstMayFinish;
    });
    await raised;

    // The first window closes while something else holds the connection, so its restore waits.
    const held = holdConnection(file.db);
    await held.holding;
    finishFirst();
    await nextMacrotask();
    let second: Promise<void> = Promise.resolve();
    file.afterNextRelease(() => {
      second = withFullDurability(file.db, 'durability_test_race_second', async () => {
        // The window's caller does some work first (a handler reading its request), so the
        // queued restore gets the connection before this write does.
        await nextMacrotask();
        await sql`INSERT INTO marker VALUES ('written in the second window')`.execute(file.db);
      });
    });
    held.release();
    await Promise.all([first, held.done]);
    await second;

    expect({
      secondWriteLevel: file.levelOf(/INSERT INTO marker/i),
      after: file.level(),
    }).toEqual({ secondWriteLevel: FULL, after: NORMAL });
  });

  it('lets every caller rethrow a raise that fails, and a later window works', async () => {
    file = new ObservedFileDatabase(directory);
    await relaxDurability(file.db);
    const failure = new Error('expected failure of the raise to FULL');
    file.failNextStatement(/PRAGMA synchronous = FULL/i, failure);

    const outcomes = await Promise.all([
      withFullDurability(file.db, 'durability_test_raise_a', () => Promise.resolve('ran')).catch(
        (error: unknown) => error
      ),
      withFullDurability(file.db, 'durability_test_raise_b', () => Promise.resolve('ran')).catch(
        (error: unknown) => error
      ),
    ]);
    const later = await withFullDurability(file.db, 'durability_test_raise_later', () =>
      Promise.resolve(file.level())
    );

    expect({ outcomes, later, after: file.level() }).toEqual({
      outcomes: [failure, failure],
      later: FULL,
      after: NORMAL,
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
