// Filesystem helpers for the script runners — cross-platform, no spawned `rm`.

import { rm } from 'node:fs/promises';
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
