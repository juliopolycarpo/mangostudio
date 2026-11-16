/**
 * Commit durability for the hub's database.
 *
 * A connection opens at `synchronous = FULL` (set explicitly by
 * `applyConnectionPragmas`, because the library default differs on macOS): every
 * commit is fsynced. The hub lowers it to `NORMAL` once its migrations have finished
 * ({@link relaxDurability}), so a streaming turn's checkpoints stop paying an
 * fsync each. At `NORMAL` the WAL is synced when SQLite checkpoints it, not on
 * every commit. A hub crash or kill loses nothing, because the OS still holds
 * the written pages. A power loss or OS crash can drop the last few seconds of
 * commits, and the database stays consistent.
 *
 * A write that records an intent before something the database cannot undo (a
 * tool that changes files or calls out, a paid image) goes through
 * {@link runDurably}, which commits it at `FULL`. WAL syncs are ordered, so that
 * one fsync also persists every commit before it. A revocation (a pairing token,
 * an API key, a session) must not come back after a power loss either; the code
 * that deletes it lives in Better Auth for sessions and API keys, which cannot be
 * handed a connection, so {@link withFullDurability} raises the level around a
 * call that uses the shared `db` itself.
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

/**
 * Connections whose baseline is below `FULL`, with that baseline: the ones
 * {@link runDurably} has to raise and then put back. {@link relaxDurability}
 * records `NORMAL`. A connection it never saw is adopted the first time a durable
 * write finds it below `FULL`, with the level it was found at.
 */
const relaxedConnections = new WeakMap<Kysely<Database>, number>();

/**
 * Open {@link withFullDurability} windows per connection. `depth` counts the callers
 * inside one; `raised` settles once the pragma has run, so a caller that joins an
 * open window also waits for it.
 */
interface FullWindow {
  depth: number;
  raised: Promise<unknown>;
}

const fullWindows = new WeakMap<Kysely<Database>, FullWindow>();

/** `PRAGMA synchronous` answers with a level: 0 off, 1 normal, 2 full, 3 extra. */
const SYNCHRONOUS_NORMAL = 1;
const SYNCHRONOUS_FULL = 2;

/** Labels already reported, so a hot path that always misses logs one line, not one per call. */
const reportedLabels = new Set<string>();

async function readLevel(db: Kysely<Database>): Promise<number | undefined> {
  const { rows } = await sql<{ synchronous: number }>`PRAGMA synchronous`.execute(db);
  return rows[0]?.synchronous;
}

/**
 * The level a durable write has to restore after it raises `db`, or `undefined`
 * when there is nothing to raise: the connection is at `FULL` already, or `db` is
 * a transaction handle, where SQLite cannot change the level. A transaction handle
 * that is below `FULL` is reported, because its commit is not durable.
 *
 * A connection {@link relaxDurability} did not record is read, and adopted when it
 * is below `FULL`. That covers a connection that did not start at `FULL` (a library
 * whose WAL default is lower) and a Kysely derived from the relaxed one
 * (`withPlugin`, `withTables`), which share the one connection.
 */
async function baselineBelowFull(db: Kysely<Database>, label: string): Promise<number | undefined> {
  if (db.isTransaction) return warnWhenBelowFull(db, label);
  const known = relaxedConnections.get(db);
  if (known !== undefined) return known;
  const level = await readLevel(db);
  // Another caller may have adopted it while this read waited for the connection.
  const adopted = relaxedConnections.get(db);
  if (adopted !== undefined) return adopted;
  if (level === undefined || level >= SYNCHRONOUS_FULL) return undefined;
  relaxedConnections.set(db, level);
  return level;
}

/**
 * Reports a durable write that is about to commit below `FULL` because
 * {@link runDurably} cannot raise the transaction handle it was given. Always
 * resolves `undefined`: there is nothing to restore.
 */
async function warnWhenBelowFull(db: Kysely<Database>, label: string): Promise<undefined> {
  if (reportedLabels.has(label)) return undefined;
  const level = await readLevel(db);
  if (level === undefined || level >= SYNCHRONOUS_FULL) return undefined;
  reportedLabels.add(label);
  logger.warn('durable_commit_not_raised', {
    label,
    synchronous: level,
    reason: 'called inside a transaction, where SQLite cannot change the level',
  });
  return undefined;
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
 * ends at `FULL` and is logged, raising the connection when it was found lower
 * (the level is read, not assumed). An in-memory database has nothing to sync and
 * stays quiet.
 *
 * On macOS it also sets `fullfsync = 1`. Apple's `fsync` stops at the drive's cache;
 * only `F_FULLFSYNC` reaches stable storage, and SQLite uses it for ordinary syncs
 * only when that pragma is on (Apple's build already uses it for checkpoints). At
 * `NORMAL` a commit does not sync at all, so the flag costs nothing there; it makes
 * the `FULL` commits of {@link runDurably} and {@link withFullDurability} durable
 * across a power loss instead of only across an operating-system crash. It is set
 * here, after the migrations, so they keep the plain `fsync` they always had.
 *
 * @example
 * await runMigrations(db);
 * await relaxDurability(db); // resolves 'normal', or 'full' when WAL is not active
 */
export async function relaxDurability(
  db: Kysely<Database>,
  pragmas: PragmaRunner = pragmaRunnerFor(db),
  platform: NodeJS.Platform = process.platform
): Promise<'normal' | 'full'> {
  const journalMode = await pragmas.read('journal_mode');
  if (journalMode !== 'wal') {
    if (journalMode !== 'memory') {
      logger.warn('synchronous_kept_full', {
        reason: 'journal mode is not wal',
        journalMode: journalMode ?? 'unknown',
      });
    }
    const level = Number(await pragmas.read('synchronous'));
    if (level < SYNCHRONOUS_FULL) await pragmas.run('synchronous = FULL');
    return 'full';
  }
  await pragmas.run('synchronous = NORMAL');
  if (platform === 'darwin') await pragmas.run('fullfsync = 1');
  relaxedConnections.set(db, SYNCHRONOUS_NORMAL);
  return 'normal';
}

/**
 * Raises a connection below `FULL` to `FULL` for the duration of `work`. Call it for a
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
 * `FULL` (not WAL, in memory, or inside a {@link withFullDurability} window). The
 * level is read, not assumed: a connection {@link relaxDurability} did not relax
 * but that is below `FULL` anyway, or a Kysely derived from the relaxed one
 * (`withPlugin`, `withTables`), is raised too and put back at the level it was
 * found at. It cannot raise a transaction handle. It then reads the level the
 * connection is at, and when that is below `FULL` the commit is not durable:
 * `label` is logged once as `durable_commit_not_raised`. A caller that has to be
 * durable and holds a transaction needs to call this around its outermost
 * transaction instead.
 *
 * @example
 * await runDurably(db, 'external_turn_attempt', (conn) => insertAttempt(row, conn));
 */
export async function runDurably<T>(
  db: Kysely<Database>,
  label: string,
  work: (conn: Kysely<Database>) => Promise<T>
): Promise<T> {
  const baseline = await baselineBelowFull(db, label);
  if (baseline === undefined) return work(db);
  return db.connection().execute(async (conn) => {
    await sql`PRAGMA synchronous = FULL`.execute(conn);
    try {
      return await work(conn);
    } finally {
      // Back to the baseline (`NORMAL` after `relaxDurability`), unless a {@link withFullDurability}
      // window is open on this connection and still needs FULL: its last caller
      // restores it. If this fails the connection stays at FULL, which is the safe
      // side, so it must not mask `work`'s result.
      if (!fullWindows.has(db)) await restoreBaseline(conn, baseline);
    }
  });
}

async function restoreBaseline(db: Kysely<Database>, baseline: number): Promise<void> {
  // `baseline` comes from `PRAGMA synchronous`, an integer 0 to 3, so it is safe to inline.
  await sql`${sql.raw(`PRAGMA synchronous = ${baseline}`)}`.execute(db).catch((error: unknown) => {
    logger.warn('synchronous_restore_failed', { error: String(error) });
  });
}

/**
 * Restores the baseline once the last caller of a window is done, deciding while it holds
 * the connection. Kysely's connection lock does not hand the connection to waiters in
 * order, so a restore queued behind other work can run after a new window has opened
 * and raised the level; checking then, not when the restore was queued, is what stops
 * it from lowering a window that is open.
 */
async function restoreUnlessWindowOpen(db: Kysely<Database>, baseline: number): Promise<void> {
  try {
    await db.connection().execute(async (conn) => {
      if (!fullWindows.has(db)) await restoreBaseline(conn, baseline);
    });
  } catch (error) {
    // The connection stays at FULL, which is the safe side.
    logger.warn('synchronous_restore_failed', { error: String(error) });
  }
}

/**
 * Runs `work` with the connection at `FULL`, for code that has to use the shared
 * `db` itself. Better Auth's session and API key deletes are the case: they run
 * on the hub's one connection through an adapter this code cannot hand a
 * connection to, so {@link runDurably} (which holds the connection) would deadlock
 * them. This raises the level, runs `work`, and restores the baseline (`NORMAL`
 * after `relaxDurability`) when the last overlapping caller is done. Anything else that commits meanwhile commits at
 * `FULL` too, which costs an fsync and loses nothing.
 *
 * Like {@link runDurably}, it reads the level instead of assuming it, and it
 * cannot raise a transaction handle; it then logs `durable_commit_not_raised` once
 * per `label` when the level is below `FULL`.
 *
 * @example
 * await withFullDurability(getDb(), 'api_key_revoke', () => api.deleteApiKey(options));
 */
export async function withFullDurability<T>(
  db: Kysely<Database>,
  label: string,
  work: () => Promise<T>
): Promise<T> {
  const baseline = await baselineBelowFull(db, label);
  if (baseline === undefined) return work();
  let window = fullWindows.get(db);
  if (window) {
    window.depth += 1;
  } else {
    window = {
      depth: 1,
      raised: sql`PRAGMA synchronous = FULL`.execute(db),
    };
    fullWindows.set(db, window);
  }
  try {
    await window.raised;
    return await work();
  } finally {
    window.depth -= 1;
    if (window.depth === 0) {
      fullWindows.delete(db);
      await restoreUnlessWindowOpen(db, baseline);
    }
  }
}
