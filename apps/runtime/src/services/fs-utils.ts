import { randomBytes } from 'node:crypto';
import {
  constants as fsConstants,
  lstatSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { PathAccessError, RuntimeServiceError } from '../errors';
import type { RuntimePathFilter } from '../methods';

export interface ObservedFileRead {
  readonly bytes: Uint8Array;
  readonly mtimeMs: number;
}

export interface ReadFileWithObservedMtimeOptions {
  readonly maxBytes?: number;
}

export const READ_FILE_MAX_BYTES = 10 * 1024 * 1024;
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
      return new PathAccessError(
        `Cannot ${action} "${resolvedPath}": it is a binary file. read_file cannot read binary files, ` +
          `so the read-before-${action} guard cannot be satisfied for this path.`
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

export function isRuntimePathAllowed(path: string, filter: RuntimePathFilter): boolean {
  const absolute = resolve(path);
  if (
    filter.allowedRoots.length > 0 &&
    !filter.allowedRoots.some((root) => isPathPrefix(resolve(root), absolute))
  ) {
    return false;
  }
  if (filter.deniedRoots.some((root) => isPathPrefix(resolve(root), absolute))) {
    return false;
  }
  if (
    filter.containmentRoot &&
    !isPathPrefix(filter.containmentRoot, resolvePathThroughExistingAncestor(absolute))
  ) {
    return false;
  }
  return true;
}

function isPathPrefix(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

const MAX_SYMLINK_HOPS = 32;

function resolvePathThroughExistingAncestor(inputPath: string): string {
  const absolutePath = resolve(inputPath);
  const root = parse(absolutePath).root;
  let resolvedPath = root;
  let pending = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let hops = 0;

  while (pending.length > 0) {
    const segment = pending.shift();
    if (segment === undefined) break;
    const candidate = resolve(resolvedPath, segment);
    const stat = lstatSyncOrNull(candidate);
    if (!stat) {
      return resolve(realpathSyncSafe(resolvedPath), segment, ...pending);
    }
    if (!stat.isSymbolicLink()) {
      resolvedPath = candidate;
      continue;
    }
    if (hops >= MAX_SYMLINK_HOPS) {
      throw new PathAccessError(`Too many symbolic links while resolving "${inputPath}".`);
    }
    hops++;
    const targetPath = resolve(dirname(candidate), readlinkSyncSafe(candidate));
    const targetRoot = parse(targetPath).root;
    resolvedPath = targetRoot;
    pending = [
      ...targetPath
        .slice(targetRoot.length)
        .split(sep)
        .filter((part) => part.length > 0),
      ...pending,
    ];
  }
  return realpathSyncSafe(resolvedPath);
}

function lstatSyncOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return null;
    throw error;
  }
}

function realpathSyncSafe(path: string): string {
  return realpathSync(path);
}

function readlinkSyncSafe(path: string): string {
  return readlinkSync(path);
}
