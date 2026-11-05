import { Database } from 'bun:sqlite';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * An OS-released SQLite exclusive lock shared by Hub startup and capture.
 * Never unlink the lock database: replacing its inode would split ownership.
 */
export async function acquireCaptureLock(databasePath: string): Promise<() => Promise<void>> {
  const path = `${databasePath}.capture-lock.sqlite`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let db: Database | undefined;
  try {
    db = new Database(path);
    await chmod(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
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
