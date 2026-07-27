import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import {
  hashLibraryDirectory,
  hashLibraryFile,
  isValidResourceSlug,
  type LibraryInstance,
  type LibraryInvalidReason,
  type LibraryResourceRef,
} from '@mangostudio/shared/library';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import { parse as parseToml } from 'smol-toml';
import type { LocationDefinition } from '../domain/registry';
import type { CachedInstanceDisplay, CachedInstanceHash, LibraryCache } from './library-cache';

const textDecoder = new TextDecoder();
const SKILL_ENTRYPOINT = 'SKILL.md';

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
}

export interface ReadLibraryInstance {
  readonly ref: LibraryResourceRef;
  readonly instance: LibraryInstance;
  readonly whitespaceHash?: string;
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
): Promise<ReadLibraryInstance[]> {
  const fs = options.fs ?? nodeFs;
  if (location.layout === 'single-file') {
    const slug = basename(locationPath, extname(locationPath));
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
    return [];
  }

  const expectedType = location.layout === 'directory-of-dirs' ? 'directory' : 'file';
  const matchingEntries = entries.filter(
    (entry) =>
      !entry.name.startsWith('.') &&
      (location.layout === 'directory-of-dirs' || matchesFormat(entry.name, location.format))
  );

  const described = await Promise.all(
    matchingEntries.map((entry) =>
      readOneEntry(
        location,
        fileSlug(entry.name),
        join(locationPath, entry.name),
        expectedType,
        options,
        fs,
        canonicalLocationPath
      )
    )
  );
  return described.flat();
}

async function readOneEntry(
  location: LocationDefinition,
  slug: string,
  path: string,
  expectedType: 'file' | 'directory',
  options: ReadLibraryInstancesOptions,
  fs: LibraryInstanceReaderFs,
  containmentRoot?: string
): Promise<ReadLibraryInstance[]> {
  if (!isValidResourceSlug(slug)) return [];

  const ref = { kind: location.kind, slug } as const;
  let metadata: FileMetadata;
  try {
    metadata = await fs.stat(path);
  } catch (error) {
    if (isMissing(error)) return [];
    return [invalidInstance(ref, location, path, 0, 'unreadable')];
  }

  const hasExpectedType = expectedType === 'directory' ? metadata.isDirectory : metadata.isFile;
  if (!hasExpectedType) {
    return [
      invalidInstance(
        ref,
        location,
        path,
        Math.max(0, Math.round(metadata.mtimeMs)),
        'unexpected-entry-type'
      ),
    ];
  }

  try {
    if (containmentRoot) {
      const canonicalPath = await fs.realPath(path);
      if (!isPathWithin(containmentRoot, canonicalPath)) throw new PathEscapeError();
    }
    const hashed =
      expectedType === 'directory'
        ? await hashDirectory(location, slug, path, metadata, options, fs)
        : await hashFile(location, slug, path, metadata, options, fs);
    const display = hashed.value.display;
    const instanceBase = {
      locationId: location.id,
      path,
      modifiedAtMs:
        expectedType === 'directory'
          ? directoryModifiedAt(hashed.fingerprint)
          : Math.max(0, Math.round(metadata.mtimeMs)),
      format: location.format,
      ...(display.title && { title: display.title }),
      ...(display.description && { description: display.description }),
      contentHash: hashed.value.contentHash,
      sizeBytes: hashed.value.sizeBytes,
    };
    const instance: LibraryInstance = display.invalidReason
      ? { ...instanceBase, valid: false, invalidReason: display.invalidReason }
      : { ...instanceBase, valid: true };

    return [{ ref, instance, whitespaceHash: hashed.value.whitespaceHash }];
  } catch (error) {
    const invalidReason: LibraryInvalidReason =
      error instanceof PathEscapeError ? 'path-escape' : 'unreadable';
    return [
      invalidInstance(
        ref,
        location,
        path,
        Math.max(0, Math.round(metadata.mtimeMs)),
        invalidReason
      ),
    ];
  }
}

async function hashFile(
  location: LocationDefinition,
  slug: string,
  path: string,
  metadata: FileMetadata,
  options: ReadLibraryInstancesOptions,
  fs: LibraryInstanceReaderFs
): Promise<{ readonly fingerprint: string; readonly value: CachedInstanceHash }> {
  const fingerprint = `${path}\0${metadata.size}\0${metadata.mtimeMs}`;
  const value = await options.cache.getOrComputeInstanceHash(
    path,
    fingerprint,
    options.force,
    async () => {
      const bytesByPath = new Map<string, Uint8Array>();
      const result = await hashLibraryFile(path, {
        async readFile(filePath) {
          const bytes = await fs.readFile(filePath);
          bytesByPath.set(filePath, bytes);
          return bytes;
        },
      });
      return {
        ...result,
        whitespaceHash: hashWhitespaceManifest([
          [basename(path), bytesByPath.get(path) ?? (await fs.readFile(path))],
        ]),
        display: await readDisplayMetadata(location, slug, path, 'file', fs, bytesByPath.get(path)),
      };
    }
  );
  return { fingerprint, value };
}

async function hashDirectory(
  location: LocationDefinition,
  slug: string,
  path: string,
  rootMetadata: FileMetadata,
  options: ReadLibraryInstancesOptions,
  fs: LibraryInstanceReaderFs
): Promise<{ readonly fingerprint: string; readonly value: CachedInstanceHash }> {
  const leaves = await collectLeafFiles(path, fs);
  const fingerprint = [
    `.\0${rootMetadata.size}\0${rootMetadata.mtimeMs}\n`,
    ...leaves.map((leaf) => `${leaf.relativePath}\0${leaf.size}\0${leaf.mtimeMs}\n`),
  ].join('');
  const value = await options.cache.getOrComputeInstanceHash(
    path,
    fingerprint,
    options.force,
    async () => {
      const bytesByCanonicalPath = new Map<string, Uint8Array>();
      const result = await hashLibraryDirectory(path, {
        listFiles: () => leaves.map((leaf) => leaf.relativePath),
        realPath: fs.realPath,
        async readFile(filePath) {
          const bytes = await fs.readFile(filePath);
          bytesByCanonicalPath.set(filePath, bytes);
          return bytes;
        },
      });
      if (!result.valid) throw new PathEscapeError();

      const whitespaceEntries = await Promise.all(
        leaves.map(async (leaf) => {
          const canonicalPath = await fs.realPath(leaf.absolutePath);
          const bytes =
            bytesByCanonicalPath.get(canonicalPath) ?? (await fs.readFile(canonicalPath));
          return [leaf.relativePath, bytes] as const;
        })
      );
      const primaryLeaf = leaves.find((leaf) => leaf.relativePath === SKILL_ENTRYPOINT);
      const primaryBytes = primaryLeaf
        ? bytesByCanonicalPath.get(await fs.realPath(primaryLeaf.absolutePath))
        : undefined;
      return {
        contentHash: result.contentHash,
        sizeBytes: result.sizeBytes,
        whitespaceHash: hashWhitespaceManifest(whitespaceEntries),
        display: await readDisplayMetadata(location, slug, path, 'directory', fs, primaryBytes),
      };
    }
  );
  return { fingerprint, value };
}

async function collectLeafFiles(
  rootPath: string,
  fs: LibraryInstanceReaderFs
): Promise<LeafFile[]> {
  const leaves: LeafFile[] = [];
  const visitedDirectories = new Set<string>();
  const canonicalRoot = await fs.realPath(rootPath);

  async function visit(directoryPath: string): Promise<void> {
    const canonicalDirectory = await fs.realPath(directoryPath);
    if (!isPathWithin(canonicalRoot, canonicalDirectory)) throw new PathEscapeError();
    if (visitedDirectories.has(canonicalDirectory)) throw new PathEscapeError();
    visitedDirectories.add(canonicalDirectory);

    const entries = await fs.readDirectory(directoryPath);
    for (const entry of entries) {
      const absolutePath = join(directoryPath, entry.name);
      const metadata = await fs.stat(absolutePath);
      if (metadata.isDirectory) {
        await visit(absolutePath);
      } else if (metadata.isFile) {
        leaves.push({
          absolutePath,
          relativePath: toPosixPath(relative(rootPath, absolutePath)),
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      }
    }
  }

  await visit(rootPath);
  return leaves.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readDisplayMetadata(
  location: LocationDefinition,
  slug: string,
  path: string,
  layout: 'file' | 'directory',
  fs: LibraryInstanceReaderFs,
  primaryBytes?: Uint8Array
): Promise<CachedInstanceDisplay> {
  const primaryPath = layout === 'directory' ? join(path, SKILL_ENTRYPOINT) : path;
  let text: string;
  if (primaryBytes) {
    text = textDecoder.decode(primaryBytes);
  } else {
    try {
      text = textDecoder.decode(await fs.readFile(primaryPath));
    } catch (error) {
      return {
        title: slug,
        invalidReason: isMissing(error) ? 'missing-entrypoint' : 'unreadable',
      };
    }
  }

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

function hashWhitespaceManifest(entries: readonly (readonly [string, Uint8Array])[]): string {
  const hash = createHash('sha256');
  hash.update('mangostudio/library/whitespace\0');
  for (const [path, bytes] of entries) {
    hash.update(path);
    hash.update('\0');
    hash.update(textDecoder.decode(bytes).replaceAll(/\s+/g, ''));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function directoryModifiedAt(fingerprint: string): number {
  let modifiedAtMs = 0;
  for (const line of fingerprint.split('\n')) {
    const raw = line.split('\0')[2];
    if (raw) modifiedAtMs = Math.max(modifiedAtMs, Number(raw));
  }
  return Math.max(0, Math.round(modifiedAtMs));
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

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const caseInsensitive = /^[A-Za-z]:[\\/]/.test(rootPath);
  const root = caseInsensitive ? rootPath.toLowerCase() : rootPath;
  const candidate = caseInsensitive ? candidatePath.toLowerCase() : candidatePath;
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

class PathEscapeError extends Error {}
