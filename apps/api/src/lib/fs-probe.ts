import { dirname } from 'node:path';

/** Minimal filesystem capability seam shared by diagnostics and library health. */
export interface FsProbe {
  exists(path: string): boolean;
  isWritable(path: string): boolean;
}

/**
 * Whether a not-yet-created path can be made: walk to the nearest existing
 * ancestor and check that it is writable.
 */
export function nearestExistingWritable(path: string, fs: FsProbe): boolean {
  let current = dirname(path);
  while (!fs.exists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
  return fs.isWritable(current);
}
