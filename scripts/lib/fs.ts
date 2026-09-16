// Filesystem helpers for the script runners — cross-platform, no spawned `rm`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from './config';

/**
 * Recursively remove paths relative to baseDir; missing paths are ignored.
 * Uses node:fs rm so it behaves the same on every platform, unlike `rm -rf`.
 * // Usage: await removePaths(['apps/api/dist', '.mango/out']);
 */
export async function removePaths(paths: string[], baseDir: string = ROOT_DIR): Promise<void> {
  await Promise.all(paths.map((path) => rm(join(baseDir, path), { recursive: true, force: true })));
}

/**
 * Run `body` in a fresh temp directory and remove it afterwards, whatever the
 * body did. The body hands back a process exit code rather than calling
 * `process.exit` itself: an exit inside the body terminates before any `finally`
 * runs, which is how a failed lane leaves its workdir — tarball, node_modules
 * and all — behind on every retry.
 * // Usage: process.exit(await withTempDir('mango-pack-', (dir) => verify(dir)));
 */
export async function withTempDir(
  prefix: string,
  body: (dir: string) => Promise<number>
): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
