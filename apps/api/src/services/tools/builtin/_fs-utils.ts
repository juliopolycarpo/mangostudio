/**
 * Shared utilities for filesystem tools: path expansion, allowlist/denylist validation.
 */

import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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

export interface AtomicWriteOptions {
  /** Refuse to replace a destination that appeared after the caller checked it. */
  readonly exclusive?: boolean;
}

/**
 * Writes through a unique same-directory temp file, then atomically commits it.
 * Existing permission bits are preserved; exclusive creates never clobber a
 * destination that another process created concurrently.
 */
export async function writeFileAtomic(
  resolvedPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<number> {
  const directory = dirname(resolvedPath);
  await mkdir(directory, { recursive: true });

  const existingMode = await getExistingMode(resolvedPath);
  const tempPath = join(
    directory,
    `.${basename(resolvedPath)}.${randomBytes(8).toString('hex')}.tmp`
  );
  const handle = await open(tempPath, 'wx', existingMode);
  try {
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    // open() applies the process umask. Reapply an existing mode so an atomic
    // overwrite cannot silently narrow or widen the user's permissions.
    if (existingMode !== undefined) await chmod(tempPath, existingMode);
    if (options.exclusive) {
      await link(tempPath, resolvedPath);
      await unlink(tempPath);
    } else {
      await rename(tempPath, resolvedPath);
    }
  } catch (error) {
    await discardTempFile(tempPath);
    throw error;
  }

  return typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
}

async function getExistingMode(resolvedPath: string): Promise<number | undefined> {
  try {
    return (await stat(resolvedPath)).mode & 0o7777;
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Best-effort temp-file cleanup that runs on the failure path, so a cleanup
 * error can never replace the write error the caller needs to see.
 */
async function discardTempFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
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
