import type { LibraryInvalidReason } from './schemas';

const textEncoder = new TextEncoder();

/**
 * Domain separators keep the two hash shapes in disjoint namespaces. Without them a file whose
 * bytes happen to spell a one-entry manifest (`<name>\0<64 hex>\n`) would hash identically to
 * the directory that manifest describes, and a file-backed and a directory-backed instance of
 * the same resource would be grouped as identical content.
 */
const FILE_HASH_DOMAIN = 'mangostudio/library/file\0';
/**
 * Versioned so the manifest-injectivity fix below changes every stored directory hash instead of
 * silently colliding with the pre-fix encoding: a length-prefixed manifest and a
 * `\0`/`\n`-delimited one can never be mistaken for each other once they hash into disjoint
 * domains.
 *
 * Advertised on the runtime capability manifest. File-backed resources are
 * unaffected — only this directory domain moved.
 */
export const DIRECTORY_HASH_DOMAIN = 'mangostudio/library/dir/v2\0';

/**
 * Peers that omit `directoryHashDomain` on hello. Directory hashing moved to
 * v2 (`mangostudio/library/dir/v2`) before this field existed, so silence is
 * that already-shipped domain rather than the pre-length-prefix v1 encoding.
 *
 * Keep this pinned at 2 when the live domain becomes v3: omitted still means
 * "built after v2 hashing and before the advertisement", not "whatever this
 * binary computes today". Pre-v2 binaries sit behind that breaking hash change
 * and cannot be distinguished on hello.
 */
export const DEFAULT_DIRECTORY_HASH_DOMAIN_VERSION = 2;

/**
 * Largest version the capability manifest and the lifecycle view accept, and
 * the bound this module enforces when deriving one. Both are the same limit on
 * purpose: a domain the runtime can hash with but not advertise would fail
 * schema validation on hello, taking the whole handshake down over a hash
 * bump. Failing here instead turns that into a test failure in this repo.
 */
export const MAX_DIRECTORY_HASH_DOMAIN_VERSION = 255;

const DIRECTORY_HASH_DOMAIN_VERSION_PATTERN = /\/v(\d+)\0$/;

/**
 * The integer the runtime advertises for {@link DIRECTORY_HASH_DOMAIN}. Derived
 * from the domain string so a v3 bump cannot forget to update the capability.
 */
export function directoryHashDomainVersion(domain: string = DIRECTORY_HASH_DOMAIN): number {
  const match = DIRECTORY_HASH_DOMAIN_VERSION_PATTERN.exec(domain);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(
      `Directory hash domain must end in /v<n>\\0 so the runtime can advertise it (got ${JSON.stringify(domain)}).`
    );
  }
  if (version > MAX_DIRECTORY_HASH_DOMAIN_VERSION) {
    throw new Error(
      `Directory hash domain version ${version} exceeds the ${MAX_DIRECTORY_HASH_DOMAIN_VERSION} the runtime can advertise; widen the capability schema in the same change.`
    );
  }
  return version;
}

/** Absent on the wire means v2 — the domain that shipped before this field. */
export function directoryHashDomainOf(advertised: number | undefined): number {
  return advertised ?? DEFAULT_DIRECTORY_HASH_DOMAIN_VERSION;
}

/**
 * Which platform's path semantics apply to the paths a {@link LibraryHashReader} returns.
 *
 * `\` is a legal POSIX filename character, so rewriting it to `/` unconditionally invents a
 * separator that is not there and lets an unrelated directory satisfy a containment check. This
 * module cannot sniff the answer — `apps/shared` stays framework-agnostic and has no
 * `process.platform` to read — so the adapter that owns a real filesystem supplies it.
 */
export type LibraryHashPathStyle = 'posix' | 'win32';

export interface LibraryHashReader {
  /**
   * Returns every leaf file under `rootPath` as a POSIX-style relative path.
   * Directory symlinks must be traversed into leaf entries by the adapter.
   */
  listFiles(rootPath: string): ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  /** Resolves symlinks and returns the canonical absolute path. */
  realPath(path: string): string | Promise<string>;
  readFile(path: string): Uint8Array | Promise<Uint8Array>;
  readonly pathStyle: LibraryHashPathStyle;
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
    contentHash: await sha256(FILE_HASH_DOMAIN, bytes),
    sizeBytes: bytes.byteLength,
  };
}

export async function hashLibraryDirectory(
  rootPath: string,
  reader: LibraryHashReader
): Promise<LibraryDirectoryHash> {
  const { pathStyle } = reader;
  const canonicalRoot = normalizeHashPath(await reader.realPath(rootPath), pathStyle);
  const relativePaths = [...(await reader.listFiles(rootPath))].sort(comparePaths);
  const manifestLines: string[] = [];
  let sizeBytes = 0;

  for (const relativePath of relativePaths) {
    const violation = relativePathViolation(relativePath, pathStyle);
    if (violation) return invalid(violation);

    const canonicalFile = normalizeHashPath(
      await reader.realPath(joinPath(canonicalRoot, relativePath)),
      pathStyle
    );
    if (!isPathWithin(canonicalRoot, canonicalFile, pathStyle)) return invalid('path-escape');

    const bytes = await reader.readFile(canonicalFile);
    const fileHash = await sha256(FILE_HASH_DOMAIN, bytes);
    // Length-prefixed so no filename can spell a manifest line: `relativePathViolation` below is
    // the policy that rejects a `\n`/`\0` name outright, and this is the property that holds even
    // if a future caller reaches the hasher another way.
    manifestLines.push(`${relativePath.length}:${relativePath}${fileHash}`);
    sizeBytes += bytes.byteLength;
  }

  return {
    contentHash: await sha256(DIRECTORY_HASH_DOMAIN, textEncoder.encode(manifestLines.join(''))),
    sizeBytes,
    valid: true,
  };
}

async function sha256(domain: string, bytes: Uint8Array): Promise<string> {
  const prefix = textEncoder.encode(domain);
  // The copy also narrows `Uint8Array<ArrayBufferLike>` to a `BufferSource` digest accepts.
  const digestInput = new Uint8Array(prefix.byteLength + bytes.byteLength);
  digestInput.set(prefix);
  digestInput.set(bytes, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical spelling of an already-resolved path, so a caller that wants to recognize the paths
 * this module hands to `readFile` keys them the same way. Backslashes are only ever a separator
 * under `'win32'` — under `'posix'` one is an ordinary filename character and survives untouched.
 */
export function normalizeHashPath(path: string, pathStyle: LibraryHashPathStyle): string {
  const normalized = pathStyle === 'win32' ? path.replaceAll('\\', '/') : path;
  if (normalized === '/') return normalized;
  return stripTrailingSlashes(normalized);
}

/**
 * Strips trailing `/` in a single linear pass.
 *
 * Replaces a `/\/+$/` cleanup that backtracks on library-supplied paths with
 * many repetitions of `/` (CodeQL js/polynomial-redos).
 */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

function joinPath(rootPath: string, relativePath: string): string {
  return `${rootPath}/${relativePath}`;
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Why a relative path cannot be hashed: `path-escape` for anything that could climb out of the
 * root (absolute, `.`, `..`, a Windows drive prefix), `unsafe-name` for a name that is safe to
 * resolve but unsafe to put in the manifest verbatim (`\n` or `\0`, both legal POSIX filename
 * bytes that could otherwise forge a manifest line).
 */
function relativePathViolation(
  path: string,
  pathStyle: LibraryHashPathStyle
): 'path-escape' | 'unsafe-name' | undefined {
  if (path.length === 0 || path.startsWith('/')) return 'path-escape';
  if (pathStyle === 'win32' && /^[A-Za-z]:[\\/]/.test(path)) return 'path-escape';
  if (path.includes('\n') || path.includes('\0')) return 'unsafe-name';

  const segments = pathStyle === 'win32' ? path.replaceAll('\\', '/').split('/') : path.split('/');
  const hasBadSegment = segments.some(
    (segment) => segment.length === 0 || segment === '.' || segment === '..'
  );
  return hasBadSegment ? 'path-escape' : undefined;
}

function isPathWithin(
  rootPath: string,
  candidatePath: string,
  pathStyle: LibraryHashPathStyle
): boolean {
  const caseInsensitive = pathStyle === 'win32';
  const root = caseInsensitive ? rootPath.toLowerCase() : rootPath;
  const candidate = caseInsensitive ? candidatePath.toLowerCase() : candidatePath;
  return candidate === root || candidate.startsWith(`${root}/`);
}

function invalid(invalidReason: LibraryInvalidReason): LibraryDirectoryHash {
  return { valid: false, invalidReason };
}
