/**
 * Shared utilities for filesystem tools: path expansion, allowlist/denylist validation.
 */

import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  assertInsideWorkdir,
  isPathPrefix,
} from '../../../modules/workspaces/application/path-containment';
import { normalizePathList, normalizeStringList, type PathListItem } from '../list-normalization';
import type { WorkdirPolicy } from '../types';

export { normalizePathList, normalizeStringList };

export function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    const home = Bun.env.HOME ?? '';
    if (!home) return path;
    if (path === '~') return home;
    return `${home}/${path.slice(2)}`;
  }
  return path;
}

export interface PathValidationSettings {
  allowedPaths: readonly PathListItem[];
  deniedPaths: readonly PathListItem[];
}

/** Chat-bound directory a relative tool path is resolved against. */
export interface WorkdirResolutionOptions {
  workdir?: string;
  workdirPolicy?: WorkdirPolicy;
}

export interface ResolvePathOptions extends WorkdirResolutionOptions {
  settings: PathValidationSettings;
}

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAccessError';
  }
}

export interface ObservedFileRead {
  readonly bytes: Uint8Array;
  /**
   * mtime of the descriptor the bytes came from, or `NaN` when the file changed
   * while it was being read and no snapshot describes those bytes.
   */
  readonly mtimeMs: number;
}

export interface ReadFileWithObservedMtimeOptions {
  /**
   * Reject files whose size on the open descriptor exceeds this many bytes.
   * Defaults to unbounded so freshness hashing can still read any observed file.
   */
  readonly maxBytes?: number;
}

/**
 * Reads a file through a single descriptor and reports the mtime that belongs to
 * the bytes returned. Stat-ing the path after the read could pick up a
 * concurrent writer's metadata and pair it with the caller's stale bytes, so the
 * descriptor is stat-ed on both sides of the read and disagreement yields `NaN`.
 * Symlinks are followed: resolving them is what a read tool is for.
 *
 * // Usage: const { bytes, mtimeMs } = await readFileWithObservedMtime(path);
 */
export async function readFileWithObservedMtime(
  resolvedPath: string,
  options: ReadFileWithObservedMtimeOptions = {}
): Promise<ObservedFileRead> {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const handle = await open(resolvedPath, 'r').catch((error: unknown) => {
    if (isErrnoException(error, 'ENOENT')) {
      throw new PathAccessError(`File not found: "${resolvedPath}"`);
    }
    throw error;
  });

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new PathAccessError(`Cannot read "${resolvedPath}": it is not a regular file.`);
    }
    if (before.size > maxBytes) {
      throw new PathAccessError(
        `Cannot read "${resolvedPath}": file is too large (${before.size} bytes; limit is ${maxBytes}).`
      );
    }

    const bytes = await handle.readFile();
    const after = await handle.stat();
    const stable = after.mtimeMs === before.mtimeMs && after.size === before.size;
    return { bytes, mtimeMs: stable ? after.mtimeMs : Number.NaN };
  } finally {
    await handle.close();
  }
}

/** Narrows a thrown value to a Node errno error with the given code. */
export function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * Reads a required path argument, throwing PathAccessError when missing.
 * Shared by the filesystem tools so their argument handling stays identical.
 *
 * // Usage: const path = getRequiredPathArg(args.path, 'path');
 */
export function getRequiredPathArg(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new PathAccessError(`Missing required ${name}.`);
  return text;
}

/**
 * Enforces the chat workdir policy on an already-resolved path, restating
 * containment failures as PathAccessError so tools report them uniformly.
 */
export function assertWorkdirContainment(
  resolvedPath: string,
  workdirPolicy: WorkdirPolicy | undefined
): void {
  if (!workdirPolicy?.restricted) return;
  try {
    assertInsideWorkdir(workdirPolicy.root, resolvedPath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Path is outside the working directory.';
    throw new PathAccessError(message);
  }
}

/**
 * Expands `~` and resolves a tool path argument, anchoring relative input to the
 * chat working directory. Relative input is rejected when no workdir is bound so
 * tools never silently fall back to the API process directory.
 *
 * // Usage: resolveWorkdirRelativePath('src/index.ts', context)
 */
export function resolveWorkdirRelativePath(
  inputPath: string,
  options: WorkdirResolutionOptions
): string {
  const expanded = expandHome(inputPath);
  if (isAbsolute(expanded)) return resolve(expanded);

  const workdir = options.workdirPolicy?.root ?? options.workdir;
  if (!workdir) {
    throw new PathAccessError(
      `Relative path "${inputPath}" cannot be resolved: no working directory is bound to this chat. Pass an absolute path.`
    );
  }

  return resolve(workdir, expanded);
}

export function resolveAndValidatePath(inputPath: string, options: ResolvePathOptions): string {
  const resolved = resolveWorkdirRelativePath(inputPath, options);
  const { settings, workdirPolicy } = options;

  const enabledAllowed = settings.allowedPaths.filter((item) => item.enabled);
  if (enabledAllowed.length > 0) {
    const isAllowed = enabledAllowed.some((allowed) => {
      const allowedResolved = resolve(expandHome(allowed.path));
      return isPathPrefix(allowedResolved, resolved);
    });
    if (!isAllowed) {
      throw new PathAccessError(`Path "${inputPath}" is not in the allowed paths.`);
    }
  }

  const enabledDenied = settings.deniedPaths.filter((item) => item.enabled);
  if (enabledDenied.length > 0) {
    const isDenied = enabledDenied.some((denied) => {
      const deniedResolved = resolve(expandHome(denied.path));
      return isPathPrefix(deniedResolved, resolved);
    });
    if (isDenied) {
      throw new PathAccessError(`Path "${inputPath}" is in the denied paths.`);
    }
  }

  assertWorkdirContainment(resolved, workdirPolicy);

  return resolved;
}
