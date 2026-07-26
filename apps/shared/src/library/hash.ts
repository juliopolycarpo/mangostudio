import type { LibraryInvalidReason } from './schemas';

const textEncoder = new TextEncoder();

export interface LibraryHashReader {
  /**
   * Returns every leaf file under `rootPath` as a POSIX-style relative path.
   * Directory symlinks must be traversed into leaf entries by the adapter.
   */
  listFiles(rootPath: string): ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  /** Resolves symlinks and returns the canonical absolute path. */
  realPath(path: string): string | Promise<string>;
  readFile(path: string): Uint8Array | Promise<Uint8Array>;
}

export interface LibraryContentHash {
  readonly contentHash: string;
  readonly sizeBytes: number;
}

export type LibraryDirectoryHash =
  | (LibraryContentHash & { readonly valid: true })
  | { readonly valid: false; readonly invalidReason: LibraryInvalidReason };

export async function hashLibraryFile(
  path: string,
  reader: Pick<LibraryHashReader, 'readFile'>
): Promise<LibraryContentHash> {
  const bytes = await reader.readFile(path);
  return {
    contentHash: await sha256(bytes),
    sizeBytes: bytes.byteLength,
  };
}

export async function hashLibraryDirectory(
  rootPath: string,
  reader: LibraryHashReader
): Promise<LibraryDirectoryHash> {
  const canonicalRoot = normalizePath(await reader.realPath(rootPath));
  const relativePaths = [...(await reader.listFiles(rootPath))].sort(comparePaths);
  const manifestLines: string[] = [];
  let sizeBytes = 0;

  for (const relativePath of relativePaths) {
    if (!isSafeRelativePath(relativePath)) return pathEscape();

    const canonicalFile = normalizePath(
      await reader.realPath(joinPath(canonicalRoot, relativePath))
    );
    if (!isPathWithin(canonicalRoot, canonicalFile)) return pathEscape();

    const bytes = await reader.readFile(canonicalFile);
    manifestLines.push(`${relativePath}\0${await sha256(bytes)}\n`);
    sizeBytes += bytes.byteLength;
  }

  return {
    contentHash: await sha256(textEncoder.encode(manifestLines.join(''))),
    sizeBytes,
    valid: true,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

function joinPath(rootPath: string, relativePath: string): string {
  return `${rootPath}/${relativePath}`;
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return false;

  const segments = path.replaceAll('\\', '/').split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const caseInsensitive = /^[A-Za-z]:\//.test(rootPath);
  const root = caseInsensitive ? rootPath.toLowerCase() : rootPath;
  const candidate = caseInsensitive ? candidatePath.toLowerCase() : candidatePath;
  return candidate === root || candidate.startsWith(`${root}/`);
}

function pathEscape(): LibraryDirectoryHash {
  return { valid: false, invalidReason: 'path-escape' };
}
