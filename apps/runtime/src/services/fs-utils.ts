import { randomBytes } from 'node:crypto';
import { constants as fsConstants, realpathSync, type Stats } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { FileTooLargeError, PathAccessError, RuntimeServiceError } from '../errors';
import type { RuntimePathFilter } from '../methods';
import { isPathPrefix, resolvePathThroughExistingAncestor } from './path-containment';

export interface ObservedFileRead {
  readonly bytes: Uint8Array;
  readonly mtimeMs: number;
}

export interface ReadFileWithObservedMtimeOptions {
  /**
   * Ceiling on the bytes this call may put in memory. Applied to what the
   * descriptor yields, not to what `stat` claims — see {@link readBounded}.
   * Absent means no ceiling.
   */
  readonly maxBytes?: number;
}

export const READ_FILE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Ceiling on a file read through `read_file`'s `hex` or `base64` view.
 *
 * Far below {@link READ_FILE_MAX_BYTES} because a byte view lands in the
 * model's context rather than being windowed away: base64 inflates by 4/3 and
 * hex by 2, so 256 KiB of file is already ~512 KiB of tokens.
 */
export const READ_FILE_MAX_BINARY_VIEW_BYTES = 256 * 1024;
export const BINARY_SNIFF_BYTES = 8 * 1024;

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
      throw new FileTooLargeError(
        `Cannot read "${resolvedPath}": file is too large (${before.size} bytes; limit is ${maxBytes}).`,
        maxBytes
      );
    }

    const bytes = await readBounded(handle, before.size, maxBytes);
    if (bytes.byteLength > maxBytes) {
      throw new FileTooLargeError(
        `Cannot read "${resolvedPath}": file is too large (more than ${maxBytes} bytes; limit is ${maxBytes}).`,
        maxBytes
      );
    }

    const after = await handle.stat();
    const stable = after.mtimeMs === before.mtimeMs && after.size === before.size;
    return { bytes, mtimeMs: stable ? after.mtimeMs : Number.NaN };
  } finally {
    await handle.close();
  }
}

/**
 * Reads at most `maxBytes + 1` bytes from an open descriptor.
 *
 * The size from `stat` is a hint, not a bound: a procfs-style entry reports
 * `size: 0` and still streams content, and an ordinary file can grow between the
 * stat and the read. Sizing the first buffer from the hint keeps the common case
 * to one allocation and one syscall, while the growth loop keeps the descriptor
 * — not the stat — the thing the ceiling is actually applied to.
 *
 * The one extra byte is what separates "exactly at the cap" from "over it";
 * without it the caller cannot tell a legal 10 MiB file from a 40 MiB one. It is
 * also why this stops one byte past the cap rather than draining the file: the
 * point of the ceiling is to keep those bytes out of memory.
 */
async function readBounded(
  handle: FileHandle,
  sizeHint: number,
  maxBytes: number
): Promise<Uint8Array> {
  const ceiling = Number.isFinite(maxBytes) ? maxBytes + 1 : Number.POSITIVE_INFINITY;
  // At least one byte, so a `size: 0` hint still reads something and the growth
  // loop has a length to double.
  const initial = Math.min(Math.max(sizeHint, 0) + 1, ceiling);
  // `alloc` rather than `allocUnsafe`: the tail past `filled` is never returned,
  // but a pooled buffer holding another file's bytes is not worth the memset.
  let buffer = Buffer.alloc(initial);
  let filled = 0;

  while (true) {
    if (filled === buffer.byteLength) {
      if (buffer.byteLength >= ceiling) break;
      const grown = Buffer.alloc(Math.min(buffer.byteLength * 2, ceiling));
      buffer.copy(grown, 0, 0, filled);
      buffer = grown;
    }
    // Position `null` reads sequentially from the descriptor's own offset, so
    // this works for anything `open` accepted rather than only for files that
    // support positional reads.
    const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }

  return buffer.subarray(0, filled);
}

export function containsNulByte(bytes: Uint8Array, limit: number): boolean {
  return bytes.subarray(0, limit).indexOf(0x00) !== -1;
}

export async function explainUnreadableMutationTarget(
  resolvedPath: string,
  action: string,
  unreadError: Error
): Promise<Error> {
  const entry = await lstat(resolvedPath).catch(() => null);
  const sizeBytes = entry?.isFile() ? entry.size : 0;
  if (sizeBytes > READ_FILE_MAX_BYTES) {
    return new PathAccessError(
      `Cannot ${action} "${resolvedPath}": it is ${sizeBytes} bytes, past the ${READ_FILE_MAX_BYTES}-byte ` +
        `read_file limit, so the read-before-${action} guard cannot be satisfied for this path.`
    );
  }
  if (entry?.isFile()) {
    const bytes = await Bun.file(resolvedPath)
      .slice(0, BINARY_SNIFF_BYTES)
      .bytes()
      .catch(() => new Uint8Array());
    if (containsNulByte(bytes, BINARY_SNIFF_BYTES)) {
      // Binary is no longer a dead end: read_file's byte view records freshness
      // exactly as a text read does, so the guard is satisfiable under the view
      // bound. Naming it here is the difference between a refusal the model can
      // act on and one it can only retry.
      return sizeBytes > READ_FILE_MAX_BINARY_VIEW_BYTES
        ? new PathAccessError(
            `Cannot ${action} "${resolvedPath}": it is a binary file of ${sizeBytes} bytes, past the ` +
              `${READ_FILE_MAX_BINARY_VIEW_BYTES}-byte read_file byte-view limit, so the ` +
              `read-before-${action} guard cannot be satisfied for this path.`
          )
        : new PathAccessError(
            `Cannot ${action} "${resolvedPath}": it is a binary file, so read_file cannot read it as ` +
              `text. Read it with view "hex" or "base64" first to satisfy the read-before-${action} guard.`
          );
    }
  }
  return unreadError;
}

export async function assertRegularFilePath(resolvedPath: string, action: string): Promise<Stats> {
  const entry = await lstat(resolvedPath).catch((error: unknown) => {
    if (isErrnoException(error, 'ENOENT')) {
      throw new PathAccessError(`File not found: "${resolvedPath}"`);
    }
    throw error;
  });
  if (!entry.isFile()) {
    throw new PathAccessError(
      `Cannot ${action} "${resolvedPath}": it is not a regular file. Directories and symbolic links are not supported.`
    );
  }
  return entry;
}

export function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class RegularFileWriteError extends RuntimeServiceError {
  constructor(message: string) {
    super('path_access', message);
    this.name = 'RegularFileWriteError';
  }
}

export interface AtomicWriteResult {
  readonly bytesWritten: number;
  readonly mtimeMs: number;
}

export async function writeRegularFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { readonly exclusive?: boolean } = {}
): Promise<AtomicWriteResult> {
  await mkdir(dirname(filePath), { recursive: true });
  const destinationMode = await inspectWriteDestination(filePath);

  const tempPath = atomicTempPath(filePath);
  try {
    const mtimeMs = await writeTempFile(tempPath, data, destinationMode);
    await commitTempFile(tempPath, filePath, options.exclusive ?? false);
    return { bytesWritten: byteLengthOf(data), mtimeMs };
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function inspectWriteDestination(filePath: string): Promise<number | undefined> {
  const entry = await lstat(filePath).catch((error: unknown) => {
    if (isErrnoException(error, 'ENOENT')) return null;
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

  const modeAllowsWriting = process.platform === 'win32' || (entry.mode & 0o222) !== 0;
  const writable =
    modeAllowsWriting &&
    (await access(filePath, fsConstants.W_OK).then(
      () => true,
      () => false
    ));
  if (!writable) {
    throw new RegularFileWriteError(`Cannot write "${filePath}": the file is not writable.`);
  }

  return entry.mode & 0o7777;
}

async function writeTempFile(
  tempPath: string,
  data: string | Uint8Array,
  mode: number | undefined
): Promise<number> {
  const handle = await open(tempPath, 'wx', mode);
  try {
    await handle.writeFile(data);
    if (mode !== undefined) await handle.chmod(mode);
    return (await handle.stat()).mtimeMs;
  } finally {
    await handle.close();
  }
}

async function commitTempFile(
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
  return resolve(dirname(filePath), `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
}

function byteLengthOf(data: string | Uint8Array): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
}

const LINK_UNSUPPORTED_CODES = new Set([
  'EXDEV',
  'EPERM',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

export async function moveRegularFileWithoutOverwrite(
  from: string,
  to: string,
  mode: number
): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  let destinationCreated = false;
  try {
    try {
      await link(from, to);
      destinationCreated = true;
    } catch (error) {
      if (!isLinkUnsupported(error)) throw error;
      await copyFile(from, to, fsConstants.COPYFILE_EXCL);
      destinationCreated = true;
      await chmod(to, mode);
    }
    await unlink(from);
  } catch (error) {
    if (destinationCreated) {
      const cleanupError = await unlink(to).catch((thrown: unknown) => thrown);
      if (cleanupError) {
        throw new PathAccessError(
          `Could not complete the move from "${from}" to "${to}", and cleanup also failed. Both paths may exist.`
        );
      }
    }
    if (isErrnoException(error, 'EEXIST')) {
      throw new PathAccessError(`"${to}" already exists. Choose a different destination.`);
    }
    if (isErrnoException(error, 'ENOENT')) {
      throw new PathAccessError(`File not found: "${from}"`);
    }
    throw error;
  }
}

function isLinkUnsupported(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return typeof error.code === 'string' && LINK_UNSUPPORTED_CODES.has(error.code);
}

interface CompiledPathRoot {
  readonly lexical: string;
  readonly canonical: string;
}

/**
 * Compiles a path policy into a per-candidate predicate. Roots are canonicalized
 * once here rather than per candidate, because glob and grep call the predicate
 * for every entry they walk.
 *
 * Allow and deny are matched against the link-resolved candidate, not its
 * lexical form: a symlink inside an allowed root that points at a denied one
 * would otherwise pass both prefix tests and hand back the denied file. Deny
 * additionally keeps the lexical test so a root that cannot be canonicalized
 * still blocks its literal prefix.
 * // Usage: const allows = compileRuntimePathGuard(params); allows(candidate)
 */
export function compileRuntimePathGuard(filter: RuntimePathFilter): (path: string) => boolean {
  const allowedRoots = filter.allowedRoots.map(compilePathRoot);
  const deniedRoots = filter.deniedRoots.map(compilePathRoot);
  // Canonicalized like the allow and deny roots, because candidates below are
  // matched link-resolved: a workdir reached through a symlink would otherwise
  // never prefix its own contents and every recursive walk would come back empty.
  const containmentRoot = filter.containmentRoot
    ? compilePathRoot(filter.containmentRoot)
    : undefined;
  if (allowedRoots.length === 0 && deniedRoots.length === 0 && !containmentRoot) {
    return () => true;
  }

  return (path: string) => {
    const absolute = resolve(path);
    const effective = resolvePathThroughExistingAncestor(absolute);
    if (
      allowedRoots.length > 0 &&
      !allowedRoots.some((root) => isPathPrefix(root.canonical, effective))
    ) {
      return false;
    }
    if (
      deniedRoots.some(
        (root) => isPathPrefix(root.canonical, effective) || isPathPrefix(root.lexical, absolute)
      )
    ) {
      return false;
    }
    if (containmentRoot && !isPathPrefix(containmentRoot.canonical, effective)) return false;
    return true;
  };
}

function compilePathRoot(root: string): CompiledPathRoot {
  const lexical = resolve(root);
  try {
    return { lexical, canonical: realpathSync(lexical) };
  } catch {
    // A configured root that does not exist yet still has a meaningful lexical
    // prefix; falling back keeps the policy usable instead of throwing.
    return { lexical, canonical: lexical };
  }
}
