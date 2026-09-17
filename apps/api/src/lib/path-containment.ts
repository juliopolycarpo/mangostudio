/**
 * Wraps the shared path-containment algorithm for hub callers.
 * Library and safe-file callers keep this import path; too-many-symlinks is
 * remapped to the historical ELOOP ErrnoException so safe-file behavior is
 * unchanged.
 */

import { PathAccessError } from '@mangostudio/shared/runtime-contract';
import { resolvePathThroughExistingAncestor as resolveThroughExistingAncestor } from '@mangostudio/shared/workspaces/host';

export function resolvePathThroughExistingAncestor(inputPath: string): string {
  try {
    return resolveThroughExistingAncestor(inputPath);
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
