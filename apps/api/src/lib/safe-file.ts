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
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { access, link, lstat, mkdir, open, readlink, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolvePathThroughExistingAncestor } from './path-containment';

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
 * Atomically write `data` to `filePath`, **writing through** a symlinked
 * destination to its target. Creates parent directories, writes a unique temp
 * file in the resolved target's directory, then renames (or hard-links for
 * `exclusive`) it into place, cleaning up the temp file on any failure.
 *
 * The rename commit swaps a directory entry rather than writing through it, so
 * a naive implementation would replace a symlink with a regular file and leave
 * its target holding the old bytes (issue #617). This writer's callers are the
 * config and secret files users deliberately symlink into dotfiles repos, where
 * detaching the link is never what they wanted — so it resolves first and
 * commits on the target. Staging in the *target's* directory is what keeps that
 * working when the dotfiles repo lives on another filesystem, where a rename
 * across mounts would fail with `EXDEV`.
 *
 * This is a deliberate split from {@link writeRegularFileAtomic}, which rejects
 * symlinks instead. Do not "fix" the inconsistency — see the note there.
 * // Usage: writeFileAtomic(secretPath, contents, { mode: 0o600 });
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: SafeWriteOptions = {}
): void {
  const target = resolveWriteTarget(filePath);
  mkdirSync(dirname(target.path), { recursive: true });

  const tempPath = atomicTempPath(target.path);
  writeTempFile(tempPath, data, options.mode ?? target.mode);

  try {
    commitTempFile(tempPath, target.path, options.exclusive ?? false, options.mode ?? target.mode);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Raised when a destination is not one the atomic writers may replace. */
export class RegularFileWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegularFileWriteError';
  }
}

interface ResolvedWriteTarget {
  /** Where the bytes actually land, after following any symlink. */
  readonly path: string;
  /** The target's current permission bits, or undefined when it does not exist. */
  readonly mode: number | undefined;
}

/**
 * Follows `filePath` to the file a write would really modify and re-validates
 * it. Resolution reuses `resolvePathThroughExistingAncestor`, which already
 * follows dangling links manually with a hop cap — a dangling link is a fresh
 * dotfiles checkout, exactly when a user first saves settings, so it creates the
 * target instead of throwing.
 */
function resolveWriteTarget(filePath: string): ResolvedWriteTarget {
  const resolvedPath = resolvePathThroughExistingAncestor(filePath);
  const entry = statOrNull(resolvedPath);
  if (!entry) return { path: resolvedPath, mode: undefined };

  if (!entry.isFile()) {
    throw new RegularFileWriteError(
      `Cannot write ${describeTarget(filePath, resolvedPath)}, which is not a regular file.`
    );
  }
  // Checked on the target, not the link: rename would otherwise replace a
  // read-only file regardless of its own mode, the other half of #617.
  if (!isWritable(resolvedPath)) {
    throw new RegularFileWriteError(
      `Cannot write ${describeTarget(filePath, resolvedPath)}, which is not writable.`
    );
  }
  return { path: resolvedPath, mode: Number(entry.mode) & 0o7777 };
}

/** Names both the link and its target, since either alone is hard to diagnose. */
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

function isWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

interface AtomicWriteResult {
  readonly bytesWritten: number;
  /** mtime of the committed inode, read from the temp descriptor before commit. */
  readonly mtimeMs: number;
}

/**
 * Asynchronously write `data` to a new or existing regular file, preserving the
 * destination's permission bits. The async counterpart of {@link writeFileAtomic},
 * for request paths that must not block the event loop.
 *
 * The rename-based commit swaps the destination's directory entry instead of
 * writing through it, so destinations it would silently detach are rejected: a
 * symlink would be replaced by a regular file and its target left stale, and a
 * read-only file would be overwritten despite its own mode. Hard-linked files
 * are still accepted — there the swap gives copy-on-write semantics, which is
 * the safer outcome, not a surprising one.
 *
 * **This deliberately diverges from {@link writeFileAtomic}, which resolves a
 * symlink and writes through it (#617).** The two policies fit their callers:
 * the sync writer serves config and secret files a user chose to link, where
 * writing through is what they expect; this one serves request-path mutations
 * where an unexpected symlink is worth surfacing loudly. A table-driven test
 * pins the difference so a "consistency" refactor fails there rather than
 * silently changing either policy.
 *
 * The returned mtime comes from the temp descriptor before the commit, so it
 * provably belongs to the bytes written; a post-commit stat could instead
 * observe another writer's replacement.
 * // Usage: await writeRegularFileAtomic(path, content, { exclusive: isNew });
 */
export async function writeRegularFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { readonly exclusive?: boolean } = {}
): Promise<AtomicWriteResult> {
  await mkdir(dirname(filePath), { recursive: true });
  const destinationMode = await inspectWriteDestination(filePath);

  const tempPath = atomicTempPath(filePath);
  try {
    const mtimeMs = await writeTempFileAsync(tempPath, data, destinationMode);
    await commitTempFileAsync(tempPath, filePath, options.exclusive ?? false);
    return { bytesWritten: byteLengthOf(data), mtimeMs };
  } catch (error) {
    // Best effort: a cleanup failure must never replace the write error.
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Returns the destination's permission bits, or `undefined` when nothing is
 * there yet, rejecting any destination the commit must not replace.
 */
async function inspectWriteDestination(filePath: string): Promise<number | undefined> {
  const entry = await lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return undefined;

  if (entry.isSymbolicLink()) {
    const target = await readlink(filePath).catch(() => null);
    throw new RegularFileWriteError(
      `Cannot write "${filePath}": it is a symbolic link${target ? ` to "${target}"` : ''}. ` +
        'Write to the link target instead.'
    );
  }
  if (!entry.isFile()) {
    throw new RegularFileWriteError(
      `Cannot write "${filePath}": the path exists and is not a regular file.`
    );
  }

  const writable = await access(filePath, fsConstants.W_OK).then(
    () => true,
    () => false
  );
  if (!writable) {
    throw new RegularFileWriteError(`Cannot write "${filePath}": the file is not writable.`);
  }

  return entry.mode & 0o7777;
}

/** Writes the temp file and returns its mtime, taken from the open descriptor. */
async function writeTempFileAsync(
  tempPath: string,
  data: string | Uint8Array,
  mode: number | undefined
): Promise<number> {
  const handle = await open(tempPath, 'wx', mode);
  try {
    await handle.writeFile(data);
    // open() applies the process umask, so an existing mode has to be reapplied
    // or an atomic overwrite would silently narrow or widen the user's bits.
    if (mode !== undefined) await handle.chmod(mode);
    return (await handle.stat()).mtimeMs;
  } finally {
    await handle.close();
  }
}

async function commitTempFileAsync(
  tempPath: string,
  filePath: string,
  exclusive: boolean
): Promise<void> {
  if (!exclusive) {
    await rename(tempPath, filePath);
    return;
  }
  await link(tempPath, filePath);
  await unlink(tempPath);
}

function atomicTempPath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
}

function byteLengthOf(data: string | Uint8Array): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
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

function commitTempFile(
  tempPath: string,
  filePath: string,
  exclusive: boolean,
  mode: number | undefined
): void {
  // open() applied the process umask, so an inherited or requested mode has to
  // be reapplied or the commit would silently narrow or widen the user's bits.
  if (mode !== undefined) chmodSync(tempPath, mode);
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
