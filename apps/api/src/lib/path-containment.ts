/**
 * Re-exports the canonical path-containment algorithm from the runtime package.
 * Library and safe-file callers keep this import path; too-many-symlinks is
 * remapped to the historical ELOOP ErrnoException so safe-file behavior is
 * unchanged.
 */

import {
  isPathPrefix,
  PathAccessError,
  resolvePathThroughExistingAncestor as resolvePathThroughExistingAncestorRuntime,
} from '@mangostudio/runtime';

export { isPathPrefix };

export function resolvePathThroughExistingAncestor(inputPath: string): string {
  try {
    return resolvePathThroughExistingAncestorRuntime(inputPath);
  } catch (error) {
    if (error instanceof PathAccessError && /too many symbolic links/i.test(error.message)) {
      throw tooManySymlinksError(inputPath);
    }
    throw error;
  }
}

function tooManySymlinksError(inputPath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ELOOP: too many symbolic links encountered, realpath '${inputPath}'`
  ) as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  error.path = inputPath;
  error.syscall = 'realpath';
  return error;
}
