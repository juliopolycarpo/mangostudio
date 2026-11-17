import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * A refusal this module words itself. Its messages name the lock's purpose and
 * (for the toolchain lock) the environment id, never a filesystem path, so a
 * caller may show one. Anything else thrown while locking is a raw errno error
 * that names a path.
 */
export class CaptureLockError extends Error {
  constructor(
    message: string,
    /** `busy`: another holder, retry later. `unsafe-path`: the files need fixing by hand. */
    readonly kind: 'busy' | 'unsafe-path'
  ) {
    super(message);
    this.name = 'CaptureLockError';
  }
}

async function existingEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function canonicalDatabasePath(path: string, purpose: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if ((await existingEntry(path))?.isSymbolicLink()) {
      throw new CaptureLockError(`${purpose} refuses a dangling database symlink.`, 'unsafe-path');
    }
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    return join(await realpath(parent), basename(path));
  }
}

async function acquireDatabaseSidecarLock(
  databasePath: string,
  suffix: string,
  purpose: string,
  busyMessage: string,
  transaction = 'BEGIN EXCLUSIVE'
): Promise<() => Promise<void>> {
  const canonical = await canonicalDatabasePath(databasePath, purpose);
  const database = await existingEntry(canonical);
  if (database && (!database.isFile() || database.nlink !== 1)) {
    throw new CaptureLockError(
      `${purpose} requires a single-link regular database file.`,
      'unsafe-path'
    );
  }
  const path = `${canonical}.${suffix}.sqlite`;
  const sidecar = await existingEntry(path);
  if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1)) {
    throw new CaptureLockError(
      `${purpose} requires a single-link regular lock file.`,
      'unsafe-path'
    );
  }

  let db: Database | undefined;
  try {
    db = new Database(path);
    db.exec(`PRAGMA busy_timeout=0; ${transaction}`);
    // SQLite must own every open descriptor for an existing lock. Closing an
    // extra file descriptor can release the process's POSIX advisory locks.
    if (!sidecar) await chmod(path, 0o600);
  } catch {
    db?.close();
    throw new CaptureLockError(busyMessage, 'busy');
  }
  const locked = db;
  return () => {
    locked.close();
    return Promise.resolve();
  };
}

/**
 * Take the OS-released ownership lock shared by Hub startup and backup.
 * Keep the sidecar after release so a second process cannot lock a replacement inode.
 * @example const release = await acquireCaptureLock('/data/mango.sqlite');
 */
export function acquireCaptureLock(databasePath: string): Promise<() => Promise<void>> {
  return acquireDatabaseSidecarLock(
    databasePath,
    'capture-lock',
    'Capture ownership',
    'User data is already in use, or the capture lock cannot be acquired. Stop the Hub before backup.'
  );
}

/**
 * Exclude token writes from CLI probes for one environment. Concurrent CLI pins share the lock.
 * @example const release = await acquireToolchainCredentialLock(path, userId, id, 'probe');
 */
export function acquireToolchainCredentialLock(
  databasePath: string,
  userId: string,
  environmentId: string,
  mode: 'probe' | 'edit'
): Promise<() => Promise<void>> {
  if (databasePath === ':memory:') return Promise.resolve(() => Promise.resolve());
  const scope = createHash('sha256')
    .update(JSON.stringify([userId, environmentId]))
    .digest('hex');
  return acquireDatabaseSidecarLock(
    databasePath,
    `toolchain-${scope}.lock`,
    'Toolchain credential ownership',
    `Environment "${environmentId}" has a toolchain pin or token edit in progress, or its credential lock cannot be acquired.`,
    // A deferred transaction takes its shared lock on the first read.
    mode === 'probe' ? 'BEGIN; SELECT count(*) FROM sqlite_schema' : 'BEGIN EXCLUSIVE'
  );
}
