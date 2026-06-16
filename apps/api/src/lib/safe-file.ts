/**
 * Safe filesystem access for user-managed config, secret, and agent files.
 *
 * These helpers close the check-then-use races CodeQL flags: writes land on a
 * unique same-directory temp file and are renamed into place (atomic on POSIX),
 * and reads open the file once and validate the open descriptor with `fstat`
 * instead of stat-ing a path that another process could swap before the read.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// O_NOFOLLOW makes a final-component symlink fail the open (ELOOP) instead of
// silently resolving to its target — preserving the "reject symlinks" guarantee
// that callers previously got from lstat. It is undefined on platforms that lack
// it (Windows), where we fall back to following links as readFileSync would.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW;

/** Owner read/write only — the mode for files that hold API keys or auth secrets. */
export const SECRET_FILE_MODE = 0o600;

export interface SafeWriteOptions {
  /** Permission bits for the created file; also applied to the temp file so it
   *  is never briefly broader than the final file. Defaults to the umask. */
  readonly mode?: number;
  /** Fail with `EEXIST` instead of overwriting when the destination exists. */
  readonly exclusive?: boolean;
}

/**
 * Atomically write `data` to `filePath`. Creates parent directories, writes a
 * unique temp file in the destination directory, then renames (or hard-links for
 * `exclusive`) it into place, cleaning up the temp file on any failure.
 * // Usage: writeFileAtomic(secretPath, contents, { mode: 0o600 });
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: SafeWriteOptions = {}
): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });

  const tempPath = join(directory, `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
  writeTempFile(tempPath, data, options.mode);

  try {
    commitTempFile(tempPath, filePath, options.exclusive ?? false);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function writeTempFile(tempPath: string, data: string | Uint8Array, mode?: number): void {
  // 'wx' (O_CREAT|O_EXCL|O_WRONLY) plus the random suffix means a collision fails
  // loudly rather than clobbering a concurrent writer's temp file.
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

function commitTempFile(tempPath: string, filePath: string, exclusive: boolean): void {
  if (!exclusive) {
    renameSync(tempPath, filePath);
    return;
  }
  // link refuses to overwrite (EEXIST), giving an atomic create that no
  // existsSync-then-write check could provide. The temp file is unlinked after.
  linkSync(tempPath, filePath);
  rmSync(tempPath, { force: true });
}

/**
 * Read a UTF-8 file, returning `null` when it does not exist instead of throwing.
 * For read-modify-write flows that previously branched on `existsSync`.
 * // Usage: const current = readUtf8FileOrNull(envPath) ?? '';
 */
export function readUtf8FileOrNull(filePath: string): string | null {
  try {
    return readRegularFileUtf8(filePath, { maxBytes: Number.POSITIVE_INFINITY }).content;
  } catch (error) {
    if (error instanceof RegularFileReadError && error.reason === 'not-found') return null;
    throw error;
  }
}

export type RegularFileReadFailure = 'not-found' | 'not-regular-file' | 'too-large' | 'unreadable';

/** Raised by {@link readRegularFileUtf8} so callers can map to their own errors. */
export class RegularFileReadError extends Error {
  constructor(readonly reason: RegularFileReadFailure) {
    super(`Cannot read file: ${reason}`);
    this.name = 'RegularFileReadError';
  }
}

export interface ReadRegularFileOptions {
  /** Reject (or truncate) content beyond this many bytes. */
  readonly maxBytes: number;
  /** Truncate to `maxBytes` instead of failing with `too-large`. */
  readonly truncateOversize?: boolean;
}

export interface RegularFileContent {
  readonly content: string;
  readonly truncated: boolean;
  readonly sizeBytes: number;
}

/**
 * Open a regular file once and read it as UTF-8, validating the open descriptor
 * with `fstat`. Symlinks and non-regular files are rejected; oversized files are
 * truncated or rejected per `truncateOversize`.
 * // Usage: readRegularFileUtf8(path, { maxBytes: 256 * 1024, truncateOversize: true });
 */
export function readRegularFileUtf8(
  filePath: string,
  options: ReadRegularFileOptions
): RegularFileContent {
  const fd = openForRead(filePath);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RegularFileReadError('not-regular-file');

    const sizeBytes = stat.size;
    const shouldTruncate = sizeBytes > options.maxBytes;
    if (shouldTruncate && !options.truncateOversize) throw new RegularFileReadError('too-large');

    const limit = shouldTruncate ? options.maxBytes : sizeBytes;
    return { content: readFromDescriptor(fd, limit), truncated: shouldTruncate, sizeBytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Confirm `filePath` is an existing, readable regular file without reading it,
 * returning its size. Shares the open-once/`fstat` guarantee of the reader.
 * // Usage: const { sizeBytes } = statRegularFile(path);
 */
export function statRegularFile(filePath: string): { sizeBytes: number } {
  const fd = openForRead(filePath);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RegularFileReadError('not-regular-file');
    return { sizeBytes: stat.size };
  } finally {
    closeSync(fd);
  }
}

function openForRead(filePath: string): number {
  try {
    return openSync(filePath, READ_FLAGS);
  } catch (error) {
    throw new RegularFileReadError(classifyOpenError(error));
  }
}

function classifyOpenError(error: unknown): RegularFileReadFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'not-found';
  // ELOOP: O_NOFOLLOW rejected a symlink. EISDIR: a directory where supported.
  if (code === 'ELOOP' || code === 'EISDIR') return 'not-regular-file';
  return 'unreadable';
}

function readFromDescriptor(fd: number, limit: number): string {
  if (limit === 0) return '';
  const buffer = Buffer.alloc(limit);
  let offset = 0;
  while (offset < limit) {
    const bytesRead = readSync(fd, buffer, offset, limit - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString('utf8');
}
