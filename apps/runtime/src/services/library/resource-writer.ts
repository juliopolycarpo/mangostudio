import type { Dirent, Stats } from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LibraryLocationId } from '@mangostudio/shared/library';
import {
  getLibraryLocation,
  type LocationDefinition,
  resourceEntryName,
} from '@mangostudio/shared/library/host';
import type { LibraryPathEnv, PathEnv } from '@mangostudio/shared/runtime-env';
import { resolvePathThroughExistingAncestor } from '../path-containment';
import { writeLibraryFileAtomic } from './atomic-write';
import {
  assertBackupId,
  type BackupStoreDeps,
  backupExistingResource,
  createBackupId,
  createBackupStoreDeps,
  pruneBackupSets,
} from './backup-store';
import {
  assertExpectedResourceEntry,
  LibraryWriteError,
  resolveContainedResourcePath,
} from './path-safety';

interface ResourceWriteInputBase {
  readonly locationId: LibraryLocationId;
  readonly slug: string;
  readonly env: LibraryPathEnv;
  /** Shared by all resources in one apply; generated when omitted. */
  readonly backupId?: string;
}

/** One file of a directory resource that travelled in the frame. */
interface DirectoryResourceFile {
  /** Posix-separated, relative to the resource root. Never absolute, never `..`. */
  readonly relativePath: string;
  readonly contents: Uint8Array;
}

/**
 * A directory resource is staged either from a path on this host or from bytes
 * the hub carried.
 *
 * Exactly one, never both. `sourceDir` is how a same-machine apply works and
 * stays byte-for-byte what it was; `files` exists because the source of a
 * cross-machine propagation is a tree on a *different* host, which no path on
 * this one can name.
 */
export interface DirectoryResourceWriteInput extends ResourceWriteInputBase {
  readonly sourceDir?: string;
  readonly files?: readonly DirectoryResourceFile[];
}

export interface FileResourceWriteInput extends ResourceWriteInputBase {
  /**
   * Raw bytes are preferred over a string: a caller that decodes and re-encodes
   * would silently drop a UTF-8 BOM and replace undecodable bytes, which the
   * apply's post-write hash check would then report as a verification failure.
   */
  readonly contents: string | Uint8Array;
}

export interface ResourceWriteResult {
  readonly locationId: LibraryLocationId;
  readonly destinationPath: string;
  readonly resolvedDestinationPath: string;
  readonly backupId: string;
  readonly backupPath?: string;
}

export interface ResourceWriterFs {
  copyTree(source: string, destination: string, purpose: 'backup' | 'stage'): Promise<void>;
  lstat(path: string): Promise<Stats | null>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<Dirent[]>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
  /**
   * Symlink-resolving atomic file write. Seamed so a test can fail one write in
   * the middle of a multi-destination apply and assert the rollback.
   */
  writeFile(path: string, contents: string | Uint8Array): void;
}

export interface ResourceWriterDeps {
  readonly fs: ResourceWriterFs;
  readonly backupDir: () => string;
  readonly backupRetentionCount: () => number;
  readonly backupRetentionBytes: () => number;
  readonly now: () => Date;
  readonly randomSuffix: () => string;
}

export interface CreateResourceWriterDepsOptions {
  readonly backupRoot: string | (() => string);
  readonly retentionCount?: number | (() => number);
  readonly retentionBytes?: number | (() => number);
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
  readonly fs?: ResourceWriterFs;
}

const nodeResourceWriterFs: ResourceWriterFs = {
  copyTree(source, destination) {
    return cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
  },
  async lstat(path) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  readdir(path) {
    return readdir(path, { withFileTypes: true });
  },
  rename,
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  stat,
  writeFile: (path, contents) => writeLibraryFileAtomic(path, contents),
};

/** Builds writer deps from an explicit backup root. Never reads hub config. */
export function createResourceWriterDeps(
  options: CreateResourceWriterDepsOptions
): ResourceWriterDeps {
  const backup = createBackupStoreDeps({
    backupRoot: options.backupRoot,
    retentionCount: options.retentionCount,
    retentionBytes: options.retentionBytes,
    now: options.now,
    randomSuffix: options.randomSuffix,
  });
  return {
    fs: options.fs ?? nodeResourceWriterFs,
    backupDir: backup.backupDir,
    backupRetentionCount: backup.retentionCount,
    backupRetentionBytes: backup.retentionBytes,
    now: backup.now,
    randomSuffix: backup.randomSuffix,
  };
}

/** Adapts the writer's dependency shape to the backup store's. */
function backupDeps(deps: ResourceWriterDeps): BackupStoreDeps {
  const base = createBackupStoreDeps({ backupRoot: deps.backupDir });
  return {
    fs: {
      ...base.fs,
      copyTree: (source, destination) => deps.fs.copyTree(source, destination, 'backup'),
      lstat: deps.fs.lstat,
      mkdir: deps.fs.mkdir,
      readdir: deps.fs.readdir,
      rename: deps.fs.rename,
      remove: deps.fs.remove,
      stat: deps.fs.stat,
    },
    backupDir: deps.backupDir,
    retentionCount: deps.backupRetentionCount,
    retentionBytes: deps.backupRetentionBytes,
    now: deps.now,
    randomSuffix: deps.randomSuffix,
  };
}

/**
 * Copies a complete directory resource into a staging sibling, then swaps it
 * into a writable registry location. Existing content is backed up first.
 */
export async function writeDirectoryResource(
  input: DirectoryResourceWriteInput,
  deps: ResourceWriterDeps
): Promise<ResourceWriteResult> {
  const location = requireWritableLocation(input.locationId, 'directory-of-dirs');
  const destination = resolveResourceDestination(location, input.slug, input.env);
  assertExpectedResourceEntry(destination.resolvedPath, 'directory');
  if ((input.sourceDir === undefined) === (input.files === undefined)) {
    throw new LibraryWriteError(
      'invalid-source',
      `Directory write for "${input.slug}" needs exactly one of a source directory or its files.`
    );
  }
  if (input.sourceDir !== undefined) await assertSourceDirectory(input.sourceDir, deps.fs);

  const store = backupDeps(deps);
  const backupId = input.backupId ?? createBackupId(store);
  assertBackupId(backupId);

  await deps.fs.mkdir(dirname(destination.resolvedPath));
  const existing = await deps.fs.lstat(destination.resolvedPath);
  const backupPath = existing
    ? await backupResource(destination.resolvedPath, input, backupId, store)
    : undefined;

  const suffix = deps.randomSuffix();
  const stagePath = siblingPath(destination.resolvedPath, suffix, 'staging');
  const previousPath = siblingPath(destination.resolvedPath, suffix, 'previous');

  try {
    if (input.sourceDir !== undefined) {
      await deps.fs.copyTree(input.sourceDir, stagePath, 'stage');
    } else {
      await stageFiles(stagePath, input.files ?? [], deps);
    }
    assertExpectedResourceEntry(destination.resolvedPath, 'directory');
    await swapStagedDirectory(stagePath, destination.resolvedPath, previousPath, existing, deps.fs);
  } catch (error) {
    await deps.fs.remove(stagePath).catch(() => undefined);
    throw error;
  }

  return {
    locationId: input.locationId,
    destinationPath: destination.logicalPath,
    resolvedDestinationPath: destination.resolvedPath,
    backupId,
    ...(backupPath && { backupPath }),
  };
}

/**
 * Materializes a transferred tree into the staging directory.
 *
 * Every relative path is validated before it becomes a path: the list arrives
 * over the protocol, and a `../../.ssh/authorized_keys` entry would otherwise be
 * written outside the staging directory — and therefore outside everything the
 * swap and the backup protect. Rejected rather than sanitized: a name that had
 * to be rewritten to be safe is not the name the source used, and quietly
 * writing a different tree than the one reviewed is its own failure.
 */
async function stageFiles(
  stagePath: string,
  files: readonly DirectoryResourceFile[],
  deps: ResourceWriterDeps
): Promise<void> {
  await deps.fs.mkdir(stagePath);
  for (const file of files) {
    const segments = file.relativePath.split('/');
    if (
      file.relativePath.length === 0 ||
      file.relativePath.includes('\\') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new LibraryWriteError(
        'path-escape',
        `Transferred library file "${file.relativePath}" is not a contained relative path.`
      );
    }
    const target = join(stagePath, ...segments);
    await deps.fs.mkdir(dirname(target));
    await deps.fs.writeFile(target, file.contents);
  }
}

/**
 * Writes a file-backed resource, backing up any existing content first. The
 * commit goes through the symlink-resolving atomic writer, so a destination
 * linked into a dotfiles repo is updated rather than detached.
 */
export async function writeFileResource(
  input: FileResourceWriteInput,
  deps: ResourceWriterDeps
): Promise<ResourceWriteResult> {
  const location = requireWritableLocation(input.locationId, 'file');
  const destination = resolveResourceDestination(location, input.slug, input.env);
  assertExpectedResourceEntry(destination.resolvedPath, 'file');

  const store = backupDeps(deps);
  const backupId = input.backupId ?? createBackupId(store);
  assertBackupId(backupId);

  await deps.fs.mkdir(dirname(destination.resolvedPath));
  const existing = await deps.fs.lstat(destination.resolvedPath);
  const backupPath = existing
    ? await backupResource(destination.resolvedPath, input, backupId, store)
    : undefined;

  // The logical path is handed to the writer, not the resolved one, so the
  // writer performs its own resolution and validation on the real target.
  deps.fs.writeFile(destination.logicalPath, input.contents);

  return {
    locationId: input.locationId,
    destinationPath: destination.logicalPath,
    resolvedDestinationPath: destination.resolvedPath,
    backupId,
    ...(backupPath && { backupPath }),
  };
}

/**
 * Shared by every mutation of a library resource, write or removal: an
 * unknown, read-only, or wrong-layout location is refused before any path is
 * resolved, so the two flows cannot drift on which locations they will touch.
 */
export function requireWritableLocation(
  locationId: LibraryLocationId,
  expected: 'directory-of-dirs' | 'file'
): LocationDefinition {
  const location = getLibraryLocation(locationId);
  if (!location) {
    throw new LibraryWriteError(
      'unsupported-location',
      `Unknown library location: "${locationId}".`
    );
  }
  if (location.access !== 'read-write') {
    throw new LibraryWriteError(
      'read-only-location',
      `Library location "${locationId}" is read-only.`
    );
  }

  const isFileLayout =
    location.layout === 'directory-of-files' || location.layout === 'single-file';
  const matches = expected === 'directory-of-dirs' ? location.layout === expected : isFileLayout;
  if (!matches) {
    throw new LibraryWriteError(
      'wrong-layout',
      `Library location "${locationId}" does not contain ${
        expected === 'directory-of-dirs' ? 'directory' : 'file'
      } resources.`
    );
  }
  return location;
}

export interface ResolvedDestination {
  readonly logicalPath: string;
  readonly resolvedPath: string;
}

/**
 * Where the resource lives inside the location. A `single-file` location names
 * exactly one resource, so its own path is the destination and the slug has to
 * be the one it declares; anything else would write an unrelated resource over
 * the user's `CLAUDE.md`.
 */
export function resolveResourceDestination(
  location: LocationDefinition,
  slug: string,
  env: PathEnv
): ResolvedDestination {
  const root = location.resolvePath(env);
  if (root === null) {
    throw new LibraryWriteError(
      'unsupported-location',
      `Library location "${location.id}" is unsupported on ${env.platform}.`
    );
  }

  if (location.layout === 'single-file') {
    if (location.resourceSlug !== slug) {
      throw new LibraryWriteError(
        'invalid-slug',
        `Library location "${location.id}" stores "${location.resourceSlug}", not "${slug}".`
      );
    }
    return { logicalPath: root, resolvedPath: resolvePathThroughExistingAncestor(root) };
  }

  const entryName =
    location.layout === 'directory-of-files' ? resourceEntryName(location, slug) : slug;
  if (entryName === null) {
    throw new LibraryWriteError(
      'wrong-layout',
      `Library location "${location.id}" has no file form for format "${location.format}".`
    );
  }
  return resolveContainedResourcePath(root, entryName);
}

async function backupResource(
  resolvedPath: string,
  input: ResourceWriteInputBase,
  backupId: string,
  store: BackupStoreDeps
): Promise<string> {
  const backupPath = await backupExistingResource(
    { resolvedPath, locationId: input.locationId, slug: input.slug, backupId },
    store
  );
  await pruneBackupSets(backupId, store);
  return backupPath;
}

function siblingPath(path: string, suffix: string, kind: 'staging' | 'previous'): string {
  return join(dirname(path), `.${basename(path)}.${suffix}.${kind}`);
}

async function assertSourceDirectory(sourceDir: string, fs: ResourceWriterFs): Promise<void> {
  let source: Stats;
  try {
    source = await fs.stat(sourceDir);
  } catch (error) {
    throw new LibraryWriteError(
      'invalid-source',
      `Cannot read library resource source "${sourceDir}": ${errorMessage(error)}`
    );
  }
  if (!source.isDirectory()) {
    throw new LibraryWriteError(
      'invalid-source',
      `Library resource source "${sourceDir}" is not a directory.`
    );
  }
}

async function swapStagedDirectory(
  stagePath: string,
  destinationPath: string,
  previousPath: string,
  existing: Stats | null,
  fs: ResourceWriterFs
): Promise<void> {
  if (!existing) {
    await fs.rename(stagePath, destinationPath);
    return;
  }

  await fs.rename(destinationPath, previousPath);
  try {
    await fs.rename(stagePath, destinationPath);
  } catch (writeError) {
    try {
      await fs.rename(previousPath, destinationPath);
    } catch (rollbackError) {
      throw new AggregateError(
        [writeError, rollbackError],
        `Library write failed and "${destinationPath}" could not be restored.`
      );
    }
    throw writeError;
  }

  // A failed cleanup leaves a recoverable stale sibling, never partial content.
  await fs.remove(previousPath).catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
