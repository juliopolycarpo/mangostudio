/**
 * Symlink-following atomic file write for library destinations.
 *
 * Library file resources (CLAUDE.md, agent prompts) are often linked into a
 * dotfiles repo. Replacing the link with a regular file would leave the target
 * stale — the opposite of what the user configured. Runtime's general
 * `writeRegularFileAtomic` rejects symlinks for tool mutations; this helper
 * keeps the library writer's historical write-through policy.
 */

import { randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { RegularFileWriteError } from '../fs-utils';
import { resolvePathThroughExistingAncestor } from '../path-containment';

export function writeLibraryFileAtomic(filePath: string, data: string | Uint8Array): void {
  const target = resolveWriteTarget(filePath);
  mkdirSync(dirname(target.path), { recursive: true });

  const tempPath = join(
    dirname(target.path),
    `.${basename(target.path)}.${randomBytes(8).toString('hex')}.tmp`
  );
  try {
    writeTempFile(tempPath, data, target.mode);
    commitTempFile(tempPath, target.path, target.mode);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

interface ResolvedWriteTarget {
  readonly path: string;
  readonly mode: number | undefined;
}

function resolveWriteTarget(filePath: string): ResolvedWriteTarget {
  const resolvedPath = resolvePathThroughExistingAncestor(filePath);
  const entry = statOrNull(resolvedPath);
  if (!entry) return { path: resolvedPath, mode: undefined };

  if (!entry.isFile()) {
    throw new RegularFileWriteError(
      `Cannot write ${describeTarget(filePath, resolvedPath)}, which is not a regular file.`
    );
  }
  const mode = Number(entry.mode);
  if (!isWritable(resolvedPath, mode)) {
    throw new RegularFileWriteError(
      `Cannot write ${describeTarget(filePath, resolvedPath)}, which is not writable.`
    );
  }
  return { path: resolvedPath, mode: mode & 0o7777 };
}

function describeTarget(filePath: string, resolvedPath: string): string {
  return filePath === resolvedPath
    ? `"${filePath}"`
    : `"${filePath}": it resolves to "${resolvedPath}"`;
}

function statOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isWritable(path: string, mode: number): boolean {
  if (process.platform !== 'win32' && (mode & 0o222) === 0) return false;
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function writeTempFile(tempPath: string, data: string | Uint8Array, mode?: number): void {
  const fd = openSync(tempPath, 'wx', mode);
  try {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    for (let offset = 0; offset < buffer.length; ) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset, null);
    }
  } finally {
    closeSync(fd);
  }
}

function commitTempFile(tempPath: string, filePath: string, mode: number | undefined): void {
  if (mode !== undefined) chmodSync(tempPath, mode);
  renameSync(tempPath, filePath);
}
