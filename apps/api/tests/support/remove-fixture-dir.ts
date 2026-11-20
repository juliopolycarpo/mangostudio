import { rmSync } from 'node:fs';

import { type RemovalRetryDependencies, removeDirectoryWithRetry } from './github-fixture-cleanup';

/** A temp directory a test owns, kept in a tracking list until its removal has succeeded. */
export interface FixtureDirectory {
  /** What the directory is for, so a failure says which fixture held on. */
  readonly role: string;
  readonly path: string;
}

/** The errno of a removal failure, looking through the retry wrapper's `cause`. */
function errnoOf(error: unknown): string {
  const direct = (error as NodeJS.ErrnoException | undefined)?.code;
  if (direct) return direct;
  const cause = (error as { cause?: NodeJS.ErrnoException } | undefined)?.cause;
  return cause?.code ?? 'no code';
}

/**
 * Remove a fixture directory, waiting out the short window in which Windows still holds a
 * just-exited child's executable or working directory (and Defender scans a freshly written
 * `.exe`). EBUSY, EPERM and ENOTEMPTY retry with bounded backoff; anything else, and the last
 * refusal at the deadline, throws naming the role, the path and the errno. It never swallows.
 *
 * Callers own their children: await each one's exit before calling. This helper does not stop
 * a process, so a child that is still running surfaces as a failure instead of being hidden.
 *
 * @example
 * await child.exited;
 * await removeFixtureDir({ role: 'fake-gh-build', path: work });
 */
export async function removeFixtureDir(
  directory: FixtureDirectory,
  dependencies?: RemovalRetryDependencies
): Promise<void> {
  try {
    await removeDirectoryWithRetry(directory.path, undefined, dependencies);
  } catch (cause) {
    throw new Error(
      `${directory.role} fixture ${JSON.stringify(directory.path)}: expected removal | received ${errnoOf(cause)}: ${String(cause)}`,
      { cause }
    );
  }
}

/** The effects {@link removeFixtureDirSync} owns, replaceable by a test. */
export interface SyncRemovalDependencies {
  readonly remove: (path: string) => void;
  readonly sleep: (milliseconds: number) => void;
  readonly now: () => number;
}

const SYNC_RETRY_DEADLINE_MS = 5_000;
const SYNC_RETRY_FIRST_DELAY_MS = 50;
const SYNC_RETRY_MAX_DELAY_MS = 500;
const SYNC_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

const defaultSyncRemovalDependencies: SyncRemovalDependencies = {
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  sleep: (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
  now: () => Date.now(),
};

/**
 * The synchronous twin of {@link removeFixtureDir}, for `afterEach` hooks and `finally` blocks that
 * are not async. Same transient codes, same bounded backoff, same error shape.
 *
 * @example
 * removeFixtureDirSync({ role: 'toml-fixture', path: directory });
 */
export function removeFixtureDirSync(
  directory: FixtureDirectory,
  dependencies: SyncRemovalDependencies = defaultSyncRemovalDependencies
): void {
  const startedAt = dependencies.now();
  let delay = SYNC_RETRY_FIRST_DELAY_MS;
  for (;;) {
    try {
      dependencies.remove(directory.path);
      return;
    } catch (cause) {
      const code = errnoOf(cause);
      const elapsed = dependencies.now() - startedAt;
      if (!SYNC_TRANSIENT_CODES.has(code) || elapsed >= SYNC_RETRY_DEADLINE_MS) {
        throw new Error(
          `${directory.role} fixture ${JSON.stringify(directory.path)}: expected removal | received ${code}: ${String(cause)}`,
          { cause }
        );
      }
      dependencies.sleep(Math.min(delay, SYNC_RETRY_DEADLINE_MS - elapsed));
      delay = Math.min(delay * 2, SYNC_RETRY_MAX_DELAY_MS);
    }
  }
}

/**
 * Remove every tracked directory, untracking only the ones whose removal succeeded.
 * A failed path stays in `directories`; every removal is attempted before the failures are
 * thrown together, so one stuck directory does not leave the rest behind.
 *
 * @example
 * afterEach(() => removeTrackedFixtureDirs(tempDirs));
 */
export async function removeTrackedFixtureDirs(
  directories: FixtureDirectory[],
  dependencies?: RemovalRetryDependencies
): Promise<void> {
  const batch = [...directories];
  const results = await Promise.allSettled(
    batch.map(async (directory) => {
      await removeFixtureDir(directory, dependencies);
      const index = directories.indexOf(directory);
      if (index !== -1) directories.splice(index, 1);
    })
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as Error] : []
  );
  if (failures.length)
    throw new AggregateError(failures, failures.map((failure) => failure.message).join('; '));
}
