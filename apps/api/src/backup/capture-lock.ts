import { Database } from 'bun:sqlite';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

async function existingEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function canonicalDatabasePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if ((await existingEntry(path))?.isSymbolicLink()) {
      throw new Error('Capture ownership refuses a dangling database symlink.');
    }
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    return join(await realpath(parent), basename(path));
  }
}

/**
 * Take the OS-released ownership lock shared by Hub startup and backup.
 * The database and its sidecar must use one physical path. Keep the sidecar
 * after release so a second process cannot lock a replacement inode.
 * @example const release = await acquireCaptureLock('/data/mango.sqlite');
 */
export async function acquireCaptureLock(databasePath: string): Promise<() => Promise<void>> {
  const canonical = await canonicalDatabasePath(databasePath);
  const database = await existingEntry(canonical);
  if (database && (!database.isFile() || database.nlink !== 1)) {
    throw new Error('Capture ownership requires a single-link regular database file.');
  }
  const path = `${canonical}.capture-lock.sqlite`;
  const sidecar = await existingEntry(path);
  if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1)) {
    throw new Error('Capture ownership requires a single-link regular lock file.');
  }

  let db: Database | undefined;
  try {
    db = new Database(path);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    // SQLite must own every open descriptor for an existing lock. Closing an
    // extra file descriptor can release the process's POSIX advisory locks.
    if (!sidecar) await chmod(path, 0o600);
  } catch {
    db?.close();
    throw new Error(
      'User data is already in use, or the capture lock cannot be acquired. Stop the Hub before backup.'
    );
  }
  const locked = db;
  return () => {
    locked.close();
    return Promise.resolve();
  };
}
