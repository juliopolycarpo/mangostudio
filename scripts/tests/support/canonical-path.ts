import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * The spelling the OS gives `path`, including for a path that does not exist yet or any more.
 *
 * `realpathSync` refuses a missing path, and resolving it lexically keeps an ancestor alias
 * (`/tmp` for `/private/tmp` on macOS, a junction or 8.3 short name on Windows). So the nearest
 * existing ancestor is resolved and the missing tail appended: a removed temporary home still
 * compares equal to what its owner saw. Anything but "missing" is the caller's error to see.
 *
 * @example
 * canonicalPath(join(tmpdir(), 'removed-home')); // '/private/tmp/removed-home' on macOS
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const resolved = resolve(path);
    const parent = dirname(resolved);
    if (parent === resolved) throw error;
    return join(canonicalPath(parent), basename(resolved));
  }
}
