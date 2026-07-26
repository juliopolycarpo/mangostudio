import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

/** Guards against symlink cycles while following dangling links manually. */
const MAX_SYMLINK_HOPS = 32;

/** True when `candidate` is `root` or a strict descendant (separator-safe). */
export function isPathPrefix(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}${sep}`);
}

function readSymlinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves an absolute or cwd-relative path through its nearest existing
 * ancestor. Dangling symlinks are followed manually so planned writes are
 * checked against where they would actually land.
 */
export function resolvePathThroughExistingAncestor(inputPath: string): string {
  const resolved = resolve(inputPath);
  let probe = resolved;
  const pending: string[] = [];
  let hops = 0;

  while (true) {
    try {
      const real = realpathSync(probe);
      return pending.length === 0 ? real : resolve(real, ...pending);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    const target = hops < MAX_SYMLINK_HOPS ? readSymlinkTarget(probe) : undefined;
    if (target !== undefined) {
      hops += 1;
      probe = resolve(dirname(probe), target);
      continue;
    }

    const name = basename(probe);
    const parent = dirname(probe);
    if (parent === probe) {
      return resolved;
    }
    pending.unshift(name);
    probe = parent;
  }
}
