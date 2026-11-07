/**
 * Wraps the shared path-containment algorithm for hub callers.
 * Library and safe-file callers keep this import path; too-many-symlinks is
 * remapped to the historical ELOOP ErrnoException so safe-file behavior is
 * unchanged.
 */

import { PathAccessError } from '@mangostudio/shared/runtime-contract';
import {
  resolveLegacyLexicalWritePath,
  resolvePathThroughExistingAncestor as resolveThroughExistingAncestor,
} from '@mangostudio/shared/workspaces/host';

export function resolvePathThroughExistingAncestor(inputPath: string): string {
  return withErrnoLoop(inputPath, resolveThroughExistingAncestor);
}

/**
 * Locate credentials written by the old atomic writer for backup exclusion.
 * // Usage: const exclude = resolveLegacyAtomicWritePath(configuredEnvPath);
 */
export function resolveLegacyAtomicWritePath(inputPath: string): string {
  return withErrnoLoop(inputPath, resolveLegacyLexicalWritePath);
}

function withErrnoLoop(inputPath: string, resolve: (path: string) => string): string {
  try {
    return resolve(inputPath);
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
