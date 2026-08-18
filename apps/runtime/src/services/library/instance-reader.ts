import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import {
  hashLibraryDirectory,
  hashLibraryFile,
  isValidKindSlug,
  isValidResourceSlug,
  type LibraryHashPathStyle,
  type LibraryInstance,
  type LibraryInvalidReason,
  type LibraryResourceRef,
  type LibraryUnreadableEntry,
  normalizeHashPath,
} from '@mangostudio/shared/library';
import type { LocationDefinition } from '@mangostudio/shared/library/host';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import { parse as parseToml } from 'smol-toml';
import { throwIfAborted } from '../cancellation';
import type { CachedInstanceDisplay, CachedInstanceHash, LibraryCache } from './cache';

const textDecoder = new TextDecoder();
/** The file inside a skill directory that carries its text and frontmatter. */
export const SKILL_ENTRYPOINT = 'SKILL.md';

/**
 * This module only ever runs on Node, so it is the one place in the library
 * stack allowed to read `process.platform` — the hasher itself stays
 * framework-agnostic and takes the answer as a parameter instead.
 */
const NODE_HASH_PATH_STYLE: LibraryHashPathStyle = process.platform === 'win32' ? 'win32' : 'posix';

/**
 * Byte budgets for a single instance. A cold scan reads and hashes every leaf
 * file of every instance, and the skill adapter runs that scan on the chat-turn
 * path, so one oversized asset must not be able to stall a turn or balloon peak
 * memory. Over-budget instances are reported `too-large` and never read.
 */
export const MAX_LIBRARY_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_LIBRARY_INSTANCE_BYTES = 16 * 1024 * 1024;
/** Parity with the legacy skill scanner, which capped SKILL.md at this size. */
export const MAX_SKILL_ENTRYPOINT_BYTES = 256 * 1024;
/** Entry count and depth caps so a hostile or huge tree fails before materializing. */
const MAX_LIBRARY_INSTANCE_ENTRIES = 10_000;
const MAX_LIBRARY_INSTANCE_DEPTH = 32;

interface FileMetadata {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

interface DirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface LibraryInstanceReaderFs {
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  realPath(path: string): Promise<string>;
  stat(path: string): Promise<FileMetadata>;
}

const nodeFs: LibraryInstanceReaderFs = {
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  readFile,
  realPath: realpath,
  async stat(path) {
    const value = await stat(path);
    return {
      size: value.size,
      mtimeMs: value.mtimeMs,
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
    };
  },
};

export interface ReadLibraryInstancesOptions {
  readonly cache: LibraryCache;
  readonly force: boolean;
  readonly fs?: LibraryInstanceReaderFs;
  readonly signal?: AbortSignal;
}

export interface ReadLibraryInstance {
  readonly ref: LibraryResourceRef;
  readonly instance: LibraryInstance;
  readonly whitespaceHash?: string;
}

/**
 * One location's scan: instances that could be named as resources, plus
 * entries that could not be named at all. The two never overlap — an entry is
 * either nameable (and may still be `invalidReason`-flagged as an instance) or
 * unreadable, never both.
 */
export interface ReadLocationInstancesResult {
  readonly instances: readonly ReadLibraryInstance[];
  readonly unreadableEntries: readonly LibraryUnreadableEntry[];
}

const EMPTY_RESULT: ReadLocationInstancesResult = { instances: [], unreadableEntries: [] };

function oneInstance(entry: ReadLibraryInstance): ReadLocationInstancesResult {
  return { instances: [entry], unreadableEntries: [] };
}

function oneUnreadableEntry(entry: LibraryUnreadableEntry): ReadLocationInstancesResult {
  return { instances: [], unreadableEntries: [entry] };
}

function mergeResults(
  results: readonly ReadLocationInstancesResult[]
): ReadLocationInstancesResult {
  return {
    instances: results.flatMap((result) => result.instances),
    unreadableEntries: results.flatMap((result) => result.unreadableEntries),
  };
}

interface LeafFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export async function readLocationInstances(
  location: LocationDefinition,
  locationPath: string,
  options: ReadLibraryInstancesOptions
): Promise<ReadLocationInstancesResult> {
  const fs = options.fs ?? nodeFs;
  throwIfAborted(options.signal);
  if (location.layout === 'single-file') {
    // The registry names the resource, so the vendor's filename never becomes
    // identity: CLAUDE.md and AGENTS.md are one `instruction:global` row, and
    // two unrelated `config.toml` files do not merge into one resource.
    const slug = location.resourceSlug ?? basename(locationPath, extname(locationPath));
    return readOneEntry(location, slug, locationPath, 'file', options, fs);
  }

  let entries: readonly DirectoryEntry[];
  let canonicalLocationPath: string;
  try {
    [entries, canonicalLocationPath] = await Promise.all([
      fs.readDirectory(locationPath),
      fs.realPath(locationPath),
    ]);
  } catch (error) {
    // A location that is absent, unreadable, or not a directory contributes no
    // resources. Only the unexpected cases are worth a log line — a missing
    // optional vendor directory is the normal state, not a fault.
    if (!isMissing(error)) {
      console.warn(`[library] Skipping unreadable location "${location.id}" at ${locationPath}.`);
    }
    return EMPTY_RESULT;
  }

  const expectedType = location.layout === 'directory-of-dirs' ? 'directory' : 'file';
  const matchingEntries = entries.filter(
    (entry) =>
      !entry.name.startsWith('.') &&
      (location.layout === 'directory-of-dirs' || matchesFormat(entry.name, location.format))
  );

  const described = await Promise.all(
    matchingEntries.map((entry) => {
      throwIfAborted(options.signal);
      return readOneEntry(
        location,
        fileSlug(entry.name),
        join(locationPath, entry.name),
        expectedType,
        options,
        fs,
        canonicalLocationPath
      );
    })
  );
  return mergeResults(described);
}

/** Reads a file-backed resource's raw bytes, for copying it to a destination. */
export function readResourceFile(
  path: string,
  fs: LibraryInstanceReaderFs = nodeFs
): Promise<Uint8Array> {
  return Promise.resolve(fs.readFile(path));
}

/**
 * Hashes what is on disk at `path` the way a scan would, for verifying a write
 * landed. Propagation re-hashes every destination it writes: "the call returned
 * without error" is not good enough on the one code path that replaces files a
 * user cares about, and a truncated write or a bad adapter output has to be
 * caught here rather than by the user noticing weeks later.
 */
export async function hashResourceAt(
  path: string,
  expectedType: 'file' | 'directory',
  fs: LibraryInstanceReaderFs = nodeFs
): Promise<string> {
  if (expectedType === 'file') {
    const { contentHash } = await hashLibraryFile(path, { readFile: () => fs.readFile(path) });
    return contentHash;
  }

  const leaves = await collectLeafFiles(path, fs);
  const result = await hashLibraryDirectory(path, {
    listFiles: () => leaves.map((leaf) => leaf.relativePath),
    realPath: fs.realPath,
    readFile: fs.readFile,
    pathStyle: NODE_HASH_PATH_STYLE,
  });
  if (!result.valid) throw new PathEscapeError();
  return result.contentHash;
}

async function readOneEntry(
  location: LocationDefinition,
  slug: string,
  path: string,
  expectedType: 'file' | 'directory',
  options: ReadLibraryInstancesOptions,
  fs: LibraryInstanceReaderFs,
  containmentRoot?: string
): Promise<ReadLocationInstancesResult> {
  // The library-wide pattern is what makes a slug expressible as a resource ref
  // at all: an entry that fails it cannot be reported as a resource, but it is
  // still reported — on the unreadable-entries channel, not silently dropped.
  if (!isValidResourceSlug(slug)) {
    return oneUnreadableEntry({
      locationId: location.id,
      name: basename(path),
      reason: 'invalid-name',
    });
  }

  const ref = { kind: location.kind, slug } as const;
  let metadata: FileMetadata;
  try {
    metadata = await fs.stat(path);
  } catch (error) {
    if (isMissing(error)) return EMPTY_RESULT;
    return oneInstance(invalidInstance(ref, location, path, 0, 'unreadable'));
  }

  const modifiedAtMs = Math.max(0, Math.round(metadata.mtimeMs));
  const hasExpectedType = expectedType === 'directory' ? metadata.isDirectory : metadata.isFile;
  if (!hasExpectedType) {
    return oneInstance(invalidInstance(ref, location, path, modifiedAtMs, 'unexpected-entry-type'));
  }
  if (!isValidKindSlug(location.kind, slug)) {
    return oneInstance(invalidInstance(ref, location, path, modifiedAtMs, 'invalid-slug'));
  }
  if (expectedType === 'file' && metadata.size > MAX_LIBRARY_FILE_BYTES) {
    return oneInstance(invalidInstance(ref, location, path, modifiedAtMs, 'too-large'));
  }

  try {
    // Hash/read the contained realpath when checked: a symlink swap between the
    // check and the open would otherwise escape containment. Keep `path` on the
    // instance for UI/write paths (caller path).
    let readPath = path;
    if (containmentRoot) {
      const canonicalPath = await fs.realPath(path);
      if (!isPathWithin(containmentRoot, canonicalPath)) throw new PathEscapeError();
      readPath = canonicalPath;
    }
    const hashed =
      expectedType === 'directory'
        ? await hashDirectory(location, slug, readPath, metadata, options, fs)
        : await hashFile(location, slug, readPath, metadata, options, fs);
    const display = hashed.value.display;
    const instanceBase = {
      locationId: location.id,
      path,
      modifiedAtMs: hashed.modifiedAtMs,
      format: location.format,
      ...(display.title && { title: display.title }),
      ...(display.description && { description: display.description }),
      contentHash: hashed.value.contentHash,
      sizeBytes: hashed.value.sizeBytes,
    };
    const instance: LibraryInstance = display.invalidReason
      ? { ...instanceBase, valid: false, invalidReason: display.invalidReason }
      : { ...instanceBase, valid: true };

    return oneInstance({ ref, instance, whitespaceHash: hashed.value.whitespaceHash });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return oneInstance(invalidInstance(ref, location, path, modifiedAtMs, invalidReasonFor(error)));
  }
}

function invalidReasonFor(error: unknown): LibraryInvalidReason {
  if (error instanceof LibraryHashInvalidError) return error.invalidReason;
  if (error instanceof PathEscapeError) return 'path-escape';
  if (error instanceof InstanceTooLargeError) return 'too-large';
  return 'unreadable';
}

interface HashedInstance {
  readonly fingerprint: string;
  readonly modifiedAtMs: number;
  readonly value: CachedInstanceHash;
}

async function hashFile(
  location: LocationDefinition,
  slug: string,
  path: string,
  metadata: FileMetadata,
  options: ReadLibraryInstancesOptions,
  fs: LibraryInstanceReaderFs
): Promise<HashedInstance> {
  const fingerprint = `${path}\0${metadata.size}\0${metadata.mtimeMs}`;
  const value = await options.cache.getOrComputeInstanceHash(
    path,
    fingerprint,
    options.force,
    async () => {
      const bytes = await fs.readFile(path);
      const result = await hashLibraryFile(path, { readFile: () => bytes });
      return {
        ...result,
        whitespaceHash: combineWhitespaceDigests([[basename(path), whitespaceDigest(bytes)]]),
        display: describeInstance(location, slug, textDecoder.decode(bytes)),
      };
    }
  );
  return { fingerprint, modifiedAtMs: Math.max(0, Math.round(metadata.mtimeMs)), value };
}

async function hashDirectory(
  location: LocationDefinition,
  slug: string,
  path: string,
  rootMetadata: FileMetadata,
  options: ReadLibraryInstancesOptions,
  fs: LibraryInstanceReaderFs
): Promise<HashedInstance> {
  const leaves = await collectLeafFiles(path, fs, options.signal);
  assertWithinByteBudget(location, leaves);
  const fingerprint = [
    `.\0${rootMetadata.size}\0${rootMetadata.mtimeMs}\n`,
    ...leaves.map((leaf) => `${leaf.relativePath}\0${leaf.size}\0${leaf.mtimeMs}\n`),
  ].join('');
  const modifiedAtMs = leaves.reduce(
    (newest, leaf) => Math.max(newest, leaf.mtimeMs),
    rootMetadata.mtimeMs
  );
  const value = await options.cache.getOrComputeInstanceHash(
    path,
    fingerprint,
    options.force,
    async () => {
      // Several leaves can share one canonical path when a leaf is a symlink to
      // a sibling, and the hash reader only ever sees the canonical one.
      const relativePathsByCanonicalPath = new Map<string, string[]>();
      await Promise.all(
        leaves.map(async (leaf) => {
          const canonicalPath = normalizeHashPath(
            await fs.realPath(leaf.absolutePath),
            NODE_HASH_PATH_STYLE
          );
          const known = relativePathsByCanonicalPath.get(canonicalPath) ?? [];
          known.push(leaf.relativePath);
          relativePathsByCanonicalPath.set(canonicalPath, known);
        })
      );

      const whitespaceDigests: [string, string][] = [];
      let entrypointText: string | undefined;
      const result = await hashLibraryDirectory(path, {
        listFiles: () => leaves.map((leaf) => leaf.relativePath),
        realPath: fs.realPath,
        pathStyle: NODE_HASH_PATH_STYLE,
        async readFile(filePath) {
          const bytes = await fs.readFile(filePath);
          // Digest each file as it is read and keep only the digest. Retaining
          // every leaf's bytes made peak memory the size of the whole library.
          for (const relativePath of relativePathsByCanonicalPath.get(filePath) ?? []) {
            whitespaceDigests.push([relativePath, whitespaceDigest(bytes)]);
            if (relativePath === SKILL_ENTRYPOINT) entrypointText = textDecoder.decode(bytes);
          }
          return bytes;
        },
      });
      if (!result.valid) throw new LibraryHashInvalidError(result.invalidReason);

      return {
        contentHash: result.contentHash,
        sizeBytes: result.sizeBytes,
        whitespaceHash: combineWhitespaceDigests(whitespaceDigests),
        display: describeInstance(location, slug, entrypointText),
      };
    }
  );
  return { fingerprint, modifiedAtMs: Math.max(0, Math.round(modifiedAtMs)), value };
}

function assertWithinByteBudget(location: LocationDefinition, leaves: readonly LeafFile[]): void {
  let totalBytes = 0;
  for (const leaf of leaves) {
    if (leaf.size > MAX_LIBRARY_FILE_BYTES) throw new InstanceTooLargeError();
    if (location.kind === 'skill' && leaf.relativePath === SKILL_ENTRYPOINT) {
      if (leaf.size > MAX_SKILL_ENTRYPOINT_BYTES) throw new InstanceTooLargeError();
    }
    totalBytes += leaf.size;
    if (totalBytes > MAX_LIBRARY_INSTANCE_BYTES) throw new InstanceTooLargeError();
  }
}

/**
 * Every file under a directory instance, with its bytes, for shipping a
 * resource to a machine that does not have it.
 *
 * Reuses the scanner's own walk so the caps that bound a scan bound a transfer
 * too: same per-file ceiling, same total, same entry count, same depth, same
 * symlink-escape refusal. A second walk with its own limits is how one of them
 * ends up looser than the other on the path that reads user files.
 *
 * The whole tree or nothing. A partially transferred skill is not a skill, and
 * writing one would leave the destination with a resource that looks present and
 * is not — worse than the copy never arriving.
 *
 * A file-backed resource answers as a single entry named after itself. Its bytes
 * have to travel exactly as they sit on disk — the apply re-hashes what it wrote
 * and compares — so they never go through a text decode, which would drop a BOM
 * and substitute anything undecodable.
 */
export async function readLibraryTree(
  rootPath: string,
  containmentRoot: string,
  options: {
    readonly fs?: LibraryInstanceReaderFs;
    readonly signal?: AbortSignal;
  } = {}
): Promise<{ relativePath: string; bytes: Uint8Array }[]> {
  const fs = options.fs ?? nodeFs;
  throwIfAborted(options.signal);
  const canonicalRoot = await fs.realPath(rootPath);
  // Re-checked after resolution: the caller's containment check ran against
  // the unresolved path, so a symlinked location — a `CLAUDE.md` pointed at
  // `/etc/passwd`, or a location directory pointed outside the agent home —
  // would otherwise resolve past that check unnoticed.
  const canonicalContainmentRoot = await fs.realPath(containmentRoot);
  if (!isPathWithin(canonicalContainmentRoot, canonicalRoot)) throw new PathEscapeError();
  const rootMetadata = await fs.stat(canonicalRoot);
  if (rootMetadata.isFile) {
    if (rootMetadata.size > MAX_LIBRARY_FILE_BYTES) throw new InstanceTooLargeError();
    const bytes = await fs.readFile(canonicalRoot);
    throwIfAborted(options.signal);
    return [{ relativePath: basename(rootPath), bytes }];
  }
  const leaves = await collectLeafFiles(rootPath, fs, options.signal);
  const files = await Promise.all(
    leaves.map(async (leaf) => {
      throwIfAborted(options.signal);
      // Re-checked after resolution, exactly as the hash pass does: the walk
      // proved containment for the directory it descended into, and a symlinked
      // leaf pointing outside the tree is a different question.
      const canonicalPath = await fs.realPath(leaf.absolutePath);
      if (!isPathWithin(canonicalRoot, canonicalPath)) throw new PathEscapeError();
      const bytes = await fs.readFile(canonicalPath);
      throwIfAborted(options.signal);
      return { relativePath: leaf.relativePath, bytes };
    })
  );
  throwIfAborted(options.signal);
  return files;
}

async function collectLeafFiles(
  rootPath: string,
  fs: LibraryInstanceReaderFs,
  signal?: AbortSignal
): Promise<LeafFile[]> {
  throwIfAborted(signal);
  const leaves: LeafFile[] = [];
  const visitedDirectories = new Set<string>();
  const canonicalRoot = await fs.realPath(rootPath);
  let totalBytes = 0;

  async function visit(directoryPath: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    if (depth > MAX_LIBRARY_INSTANCE_DEPTH) throw new InstanceTooLargeError();
    const canonicalDirectory = await fs.realPath(directoryPath);
    if (!isPathWithin(canonicalRoot, canonicalDirectory)) throw new PathEscapeError();
    if (visitedDirectories.has(canonicalDirectory)) throw new PathEscapeError();
    visitedDirectories.add(canonicalDirectory);

    const entries = await fs.readDirectory(directoryPath);
    for (const entry of entries) {
      throwIfAborted(signal);
      const absolutePath = join(directoryPath, entry.name);
      const metadata = await fs.stat(absolutePath);
      if (metadata.isDirectory) {
        await visit(absolutePath, depth + 1);
      } else if (metadata.isFile) {
        totalBytes += metadata.size;
        if (totalBytes > MAX_LIBRARY_INSTANCE_BYTES) throw new InstanceTooLargeError();
        if (leaves.length >= MAX_LIBRARY_INSTANCE_ENTRIES) throw new InstanceTooLargeError();
        leaves.push({
          absolutePath,
          relativePath: toPosixPath(relative(rootPath, absolutePath)),
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      }
    }
  }

  await visit(rootPath, 0);
  return leaves.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/**
 * Derives display metadata from the entrypoint text the hash pass already read.
 * `text` is undefined only when a directory instance has no entrypoint at all —
 * an unreadable one fails the hash pass first and never reaches here.
 */
function describeInstance(
  location: LocationDefinition,
  slug: string,
  text: string | undefined
): CachedInstanceDisplay {
  if (text === undefined) return { title: slug, invalidReason: 'missing-entrypoint' };

  try {
    if (location.format === 'markdown-frontmatter' || location.format === 'mdc') {
      const { frontmatter } = parseMarkdownFrontmatter(text);
      const title = scalarString(frontmatter.name)?.trim() || slug;
      const description = scalarString(frontmatter.description)?.trim();
      if (location.kind === 'skill' && (title !== slug || !description)) {
        return { title, description, invalidReason: 'invalid-metadata' };
      }
      return { title, ...(description && { description }) };
    }
    if (location.format === 'json-settings') {
      const value = JSON.parse(text);
      return isObject(value) ? { title: slug } : { title: slug, invalidReason: 'invalid-metadata' };
    }
    if (location.format === 'toml-agent' || location.format === 'toml-settings') {
      const value = parseToml(text);
      const title =
        location.format === 'toml-agent' && typeof value.name === 'string'
          ? value.name.trim() || slug
          : slug;
      const description =
        location.format === 'toml-agent' && typeof value.description === 'string'
          ? value.description.trim()
          : undefined;
      return isObject(value)
        ? { title, ...(description && { description }) }
        : { title: slug, invalidReason: 'invalid-metadata' };
    }
    return { title: slug };
  } catch {
    return { title: slug, invalidReason: 'invalid-metadata' };
  }
}

function invalidInstance(
  ref: LibraryResourceRef,
  location: LocationDefinition,
  path: string,
  modifiedAtMs: number,
  invalidReason: LibraryInvalidReason
): ReadLibraryInstance {
  return {
    ref,
    instance: {
      locationId: location.id,
      path,
      modifiedAtMs,
      format: location.format,
      title: ref.slug,
      valid: false,
      invalidReason,
    },
  };
}

function matchesFormat(name: string, format: LocationDefinition['format']): boolean {
  const extension = extname(name).toLowerCase();
  if (format === 'markdown-frontmatter') return extension === '.md';
  if (format === 'mdc') return extension === '.mdc';
  if (format === 'toml-agent' || format === 'toml-settings') return extension === '.toml';
  if (format === 'json-settings') return extension === '.json';
  if (format === 'rules-dsl') return extension === '.rules';
  return true;
}

function fileSlug(name: string): string {
  return basename(name, extname(name));
}

function whitespaceDigest(bytes: Uint8Array): string {
  return createHash('sha256')
    .update(textDecoder.decode(bytes).replaceAll(/\s+/g, ''))
    .digest('hex');
}

/** Order-independent so it never depends on which order the hash pass read in. */
function combineWhitespaceDigests(entries: readonly (readonly [string, string])[]): string {
  const hash = createHash('sha256');
  hash.update('mangostudio/library/whitespace\0');
  for (const [path, digest] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`${path}\0${digest}\n`);
  }
  return hash.digest('hex');
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.replaceAll(sep, '/');
}

/** Containment over canonical paths, case-insensitive only on Windows drives. */
export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const caseInsensitive = /^[A-Za-z]:[\\/]/.test(rootPath);
  const root = caseInsensitive ? rootPath.toLowerCase() : rootPath;
  const candidate = caseInsensitive ? candidatePath.toLowerCase() : candidatePath;
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export class PathEscapeError extends Error {}
export class InstanceTooLargeError extends Error {}

/**
 * A directory hash pass failed for a reason `hashLibraryDirectory` already
 * classified — `path-escape` or `unsafe-name` — and that classification must
 * survive the throw/catch back to `readOneEntry` instead of collapsing to a
 * generic escape.
 */
class LibraryHashInvalidError extends Error {
  constructor(readonly invalidReason: LibraryInvalidReason) {
    super(`Library directory hash invalid: ${invalidReason}`);
  }
}
