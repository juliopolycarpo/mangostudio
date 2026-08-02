import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isValidResourceSlug } from '@mangostudio/shared/library';
import { RegularFileWriteError } from '../fs-utils';
import { isPathPrefix, resolvePathThroughExistingAncestor } from '../path-containment';

export type LibraryWriteFailure =
  | 'invalid-slug'
  | 'path-escape'
  | 'unexpected-entry-type'
  | 'read-only-location'
  | 'unsupported-location'
  | 'wrong-layout'
  | 'invalid-source';

/** Stable write-policy error shared by the resource writer and later apply flow. */
export class LibraryWriteError extends RegularFileWriteError {
  constructor(
    readonly reason: LibraryWriteFailure,
    message: string
  ) {
    super(message);
    this.name = 'LibraryWriteError';
  }
}

export interface ContainedResourcePath {
  /** User-facing path beneath the code-defined location root. */
  readonly logicalPath: string;
  /** Canonical root after resolving its nearest existing ancestor. */
  readonly resolvedRoot: string;
  /** Physical destination used for writes, including symlinked ancestors. */
  readonly resolvedPath: string;
}

/**
 * Resolves a one-segment resource slug under a code-defined location root and
 * checks containment after following symlinks.
 */
export function resolveContainedResourcePath(
  locationRoot: string,
  slug: string
): ContainedResourcePath {
  if (!isAbsolute(locationRoot)) {
    throw new LibraryWriteError(
      'path-escape',
      `Library location root must be absolute: "${locationRoot}".`
    );
  }
  if (!isValidResourceSlug(slug)) {
    throw new LibraryWriteError('invalid-slug', `Invalid library resource slug: "${slug}".`);
  }

  const logicalRoot = resolve(locationRoot);
  const logicalPath = join(logicalRoot, slug);
  let resolvedRoot: string;
  let resolvedPath: string;
  try {
    resolvedRoot = resolvePathThroughExistingAncestor(logicalRoot);
    resolvedPath = resolvePathThroughExistingAncestor(logicalPath);
  } catch (error) {
    throw new LibraryWriteError(
      'path-escape',
      `Cannot safely resolve library destination "${logicalPath}": ${errorMessage(error)}`
    );
  }

  if (!isPathPrefix(resolvedRoot, resolvedPath) || resolvedPath === resolvedRoot) {
    throw new LibraryWriteError(
      'path-escape',
      `Library destination "${logicalPath}" resolves outside "${logicalRoot}".`
    );
  }

  return { logicalPath, resolvedRoot, resolvedPath };
}

/**
 * Refuses devices, sockets, FIFOs, and layout mismatches before a rename can
 * replace them. Symlinks are inspected through their targets.
 */
export function assertExpectedResourceEntry(path: string, expected: 'directory' | 'file'): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new LibraryWriteError(
      'unexpected-entry-type',
      `Cannot inspect library destination "${path}": ${errorMessage(error)}`
    );
  }

  const matches = expected === 'directory' ? stats.isDirectory() : stats.isFile();
  if (!matches) {
    throw new LibraryWriteError(
      'unexpected-entry-type',
      `Cannot write "${path}": the path exists and is not a regular ${expected}.`
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
