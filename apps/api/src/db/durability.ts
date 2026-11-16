/**
 * Commit durability for the hub's database.
 *
 * A connection opens at SQLite's default `synchronous = FULL`: every commit is
 * fsynced. The hub lowers it to `NORMAL` once its migrations have finished
 * ({@link relaxDurability}), so a streaming turn's checkpoints stop paying an
 * fsync each. At `NORMAL` the WAL is synced when SQLite checkpoints it, not on
 * every commit. A hub crash or kill loses nothing, because the OS still holds
 * the written pages. A power loss or OS crash can drop the last few seconds of
 * commits, and the database stays consistent.
 *
 * A write that records an intent before something the database cannot undo (a
 * tool that changes files or calls out, a paid image) goes through
 * {@link runDurably}, which commits it at `FULL`. WAL syncs are ordered, so that
 * one fsync also persists every commit before it.
 */

import { type Kysely, sql } from 'kysely';

import { createDiagnosticLogger } from '../lib/logger';
import type { Database } from './types';

const logger = createDiagnosticLogger('db');

/** The two pragma operations durability needs, so a test can stand in for a connection. */
export interface PragmaRunner {
  /** First column of the row `PRAGMA <statement>` returns, e.g. `wal` for `journal_mode`. */
  read(statement: string): Promise<string | undefined>;
  run(statement: string): Promise<void>;
}

/** Connections whose baseline is `NORMAL`: the ones {@link runDurably} has to raise. */
const relaxedConnections = new WeakSet<Kysely<Database>>();

/** `PRAGMA synchronous` answers with a level: 0 off, 1 normal, 2 full, 3 extra. */
const SYNCHRONOUS_FULL = 2;

/** Labels already reported, so a hot path that always misses logs one line, not one per call. */
const reportedLabels = new Set<string>();

/**
 * Reports a durable write that is about to commit below `FULL` because
 * {@link runDurably} could not raise the connection it was given.
 */
async function warnWhenBelowFull(db: Kysely<Database>, label: string): Promise<void> {
  if (reportedLabels.has(label)) return;
  const { rows } = await sql<{ synchronous: number }>`PRAGMA synchronous`.execute(db);
  const level = rows[0]?.synchronous;
  if (level === undefined || level >= SYNCHRONOUS_FULL) return;
  reportedLabels.add(label);
  logger.warn('durable_commit_not_raised', {
    label,
    synchronous: level,
    reason: db.isTransaction
      ? 'called inside a transaction, where SQLite cannot change the level'
      : 'called with a Kysely that is not the relaxed connection',
  });
}

function pragmaRunnerFor(db: Kysely<Database>): PragmaRunner {
  return {
    async read(statement) {
      const { rows } = await sql<
        Record<string, unknown>
      >`${sql.raw(`PRAGMA ${statement}`)}`.execute(db);
      const first = rows[0];
      return first ? String(Object.values(first)[0]) : undefined;
    },
    async run(statement) {
      await sql`${sql.raw(`PRAGMA ${statement}`)}`.execute(db);
    },
  };
}

/**
 * Lowers `synchronous` to `NORMAL`, but only on a connection that is really in
 * WAL mode. `PRAGMA journal_mode = WAL` can quietly leave another mode in place
 * (a filesystem without shared memory, a read-only database), and `NORMAL`
 * outside WAL gives up the sync the rollback journal depends on. Any other mode
 * keeps `FULL` and is logged. An in-memory database has nothing to sync and
 * stays quiet.
 *
 * @example
 * await runMigrations(db);
 * await relaxDurability(db); // resolves 'normal', or 'full' when WAL is not active
 */
export async function relaxDurability(
  db: Kysely<Database>,
  pragmas: PragmaRunner = pragmaRunnerFor(db)
): Promise<'normal' | 'full'> {
  const journalMode = await pragmas.read('journal_mode');
  if (journalMode !== 'wal') {
    if (journalMode !== 'memory') {
      logger.warn('synchronous_kept_full', {
        reason: 'journal mode is not wal',
        journalMode: journalMode ?? 'unknown',
      });
    }
    return 'full';
  }
  await pragmas.run('synchronous = NORMAL');
  relaxedConnections.add(db);
  return 'normal';
}

/**
 * Raises a relaxed connection to `FULL` for the duration of `work`. Call it for a
 * write whose loss on power failure would let the hub repeat something it cannot
 * undo; the commit then fsyncs, and so does everything committed before it.
 *
 * `work` receives a Kysely bound to the held connection and must use that one:
 * the hub has a single connection, so reaching for the outer `db` inside `work`
 * waits on a connection that `work` itself is holding. A transaction may start
 * inside `work` (SQLite refuses to change `synchronous` inside one, which is why
 * the raise wraps it and does not live in it).
 *
 * It runs `work` directly, with no raise, when the connection is already at
 * `FULL` (not relaxed, not WAL, in memory). It cannot raise a connection from a
 * transaction handle, or from a Kysely derived from the relaxed one
 * (`withPlugin`, `withTables`), because it cannot tell which connection they
 * hold. It then reads the level the connection is at, and when that is below
 * `FULL` the commit is not durable: `label` is logged once as
 * `durable_commit_not_raised`. A caller that has to be durable and holds a
 * transaction needs to call this around its outermost transaction instead.
 *
 * @example
 * await runDurably(db, 'external_turn_attempt', (conn) => insertAttempt(row, conn));
 */
export async function runDurably<T>(
  db: Kysely<Database>,
  label: string,
  work: (conn: Kysely<Database>) => Promise<T>
): Promise<T> {
  if (db.isTransaction || !relaxedConnections.has(db)) {
    await warnWhenBelowFull(db, label);
    return work(db);
  }
  return db.connection().execute(async (conn) => {
    await sql`PRAGMA synchronous = FULL`.execute(conn);
    try {
      return await work(conn);
    } finally {
      // Back to the baseline `relaxDurability` set. If this fails the connection
      // stays at FULL, which is the safe side, so it must not mask `work`'s result.
      await sql`PRAGMA synchronous = NORMAL`.execute(conn).catch((error: unknown) => {
        logger.warn('synchronous_restore_failed', { error: String(error) });
      });
    }
  });
}
