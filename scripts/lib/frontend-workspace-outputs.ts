import { Database } from 'bun:sqlite';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Give a cache replay an empty frontend output tree and retain the previous
 * bundle and metafile until the workspace build succeeds.
 * @example await buildWithCleanFrontendOutputs(root, () => runWorkspaceBuild());
 */
export async function buildWithCleanFrontendOutputs(
  root: string,
  build: () => number | Promise<number>
): Promise<number> {
  const frontend = join(root, 'apps/frontend');
  const metadata = join(root, '.mango');
  const dist = join(frontend, 'dist');
  const metafile = join(frontend, 'dist-metafile.json');
  const requiredOutputs = [join(dist, 'index.html'), metafile];
  const requireOutputs = (expected: string): void => {
    for (const path of requiredOutputs) {
      const output = lstatSync(path, { throwIfNoEntry: false });
      if (!output) throw new Error(`${expected} | received missing file ${path}`);
      if (!output.isFile()) throw new Error(`${expected} | received non-file ${path}`);
    }
  };
  mkdirSync(metadata, { recursive: true });
  // Keep the same lock file between runs so simultaneous builds contend on one inode.
  const lock = new Database(join(metadata, 'frontend-workspace-build.sqlite'));
  try {
    try {
      lock.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new Error(
        `expected exclusive access to ${frontend} | received a busy or unavailable build lock`,
        { cause: error }
      );
    }

    const backup = mkdtempSync(join(frontend, '.dist-backup-'));
    const previous = new Map<string, string>();
    let emptyDist: ReturnType<typeof lstatSync> | undefined;
    let complete = false;
    const settle = (): void => {
      process.off('exit', settle);
      try {
        if (!complete) {
          const current = lstatSync(dist, { throwIfNoEntry: false });
          // A replay writes inside our directory. A compiler publish replaces
          // it, and its separate metafile publication can still fail.
          const ownsDist =
            emptyDist && current?.dev === emptyDist.dev && current.ino === emptyDist.ino;
          if (ownsDist) {
            rmSync(dist, { recursive: true, force: true });
            rmSync(metafile, { recursive: true, force: true });
          }
          if (ownsDist || !current || !emptyDist) {
            // Check the pair before restoring either file. A competing writer
            // can occupy one destination while leaving the other absent.
            const occupied = [...previous.keys()].find((path) =>
              lstatSync(path, { throwIfNoEntry: false })
            );
            if (occupied) {
              throw new Error(
                `expected absent rollback destinations | received occupied path ${occupied}`
              );
            }
            for (const [path, saved] of previous) renameSync(saved, path);
          } else if (previous.size > 0) {
            requireOutputs('expected complete replacement outputs');
          }
        }
        rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        throw new Error(
          `could not settle frontend build outputs at ${frontend} | ${error instanceof Error ? error.message : String(error)}; backup at ${backup}`,
          {
            cause: error,
          }
        );
      }
    };
    process.once('exit', settle);
    try {
      for (const name of ['dist', 'dist-metafile.json']) {
        const output = join(frontend, name);
        if (lstatSync(output, { throwIfNoEntry: false })) {
          const saved = join(backup, name);
          renameSync(output, saved);
          previous.set(output, saved);
        }
      }
      mkdirSync(dist);
      emptyDist = lstatSync(dist);
      const exitCode = await build();
      if (exitCode !== 0) return exitCode;
      requireOutputs('expected frontend build output');
      complete = true;
      return exitCode;
    } finally {
      settle();
    }
  } finally {
    lock.close();
  }
}
