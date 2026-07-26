import { randomBytes } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LibraryLocationId } from '@mangostudio/shared/library';
import { getConfig } from '../../../lib/config';
import {
  assertExpectedResourceEntry,
  LibraryWriteError,
  resolveContainedResourcePath,
} from '../domain/path-safety';
import { getLibraryLocation, type PathEnv } from '../domain/registry';

export interface DirectoryResourceWriteInput {
  readonly locationId: LibraryLocationId;
  readonly slug: string;
  readonly sourceDir: string;
  readonly env: PathEnv;
  /** Shared by all resources in one apply; generated when omitted. */
  readonly backupId?: string;
}

export interface DirectoryResourceWriteResult {
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
}

export interface ResourceWriterDeps {
  readonly fs: ResourceWriterFs;
  readonly backupDir: () => string;
  readonly backupRetentionCount: () => number;
  readonly now: () => Date;
  readonly randomSuffix: () => string;
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
};

const defaultResourceWriterDeps: ResourceWriterDeps = {
  fs: nodeResourceWriterFs,
  backupDir: () => getConfig().library.backupDir,
  backupRetentionCount: () => getConfig().library.backupRetentionCount,
  now: () => new Date(),
  randomSuffix: () => randomBytes(8).toString('hex'),
};

/**
 * Copies a complete directory resource into a staging sibling, then swaps it
 * into a writable registry location. Existing content is backed up first.
 */
export async function writeDirectoryResource(
  input: DirectoryResourceWriteInput,
  overrides: Partial<ResourceWriterDeps> = {}
): Promise<DirectoryResourceWriteResult> {
  const deps = { ...defaultResourceWriterDeps, ...overrides };
  const location = getLibraryLocation(input.locationId);
  if (!location) {
    throw new LibraryWriteError(
      'unsupported-location',
      `Unknown library location: "${input.locationId}".`
    );
  }
  if (location.access !== 'read-write') {
    throw new LibraryWriteError(
      'read-only-location',
      `Library location "${input.locationId}" is read-only.`
    );
  }
  if (location.layout !== 'directory-of-dirs') {
    throw new LibraryWriteError(
      'wrong-layout',
      `Library location "${input.locationId}" does not contain directory resources.`
    );
  }

  const root = location.resolvePath(input.env);
  if (root === null) {
    throw new LibraryWriteError(
      'unsupported-location',
      `Library location "${input.locationId}" is unsupported on ${input.env.platform}.`
    );
  }

  const destination = resolveContainedResourcePath(root, input.slug);
  assertExpectedResourceEntry(destination.resolvedPath, 'directory');
  await assertSourceDirectory(input.sourceDir, deps.fs);

  const backupId = input.backupId ?? createBackupId(deps);
  assertBackupId(backupId);
  const retentionCount = deps.backupRetentionCount();
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1) {
    throw new TypeError('Library backup retention count must be a positive integer.');
  }

  await deps.fs.mkdir(destination.resolvedRoot);
  const existing = await deps.fs.lstat(destination.resolvedPath);
  const backupPath = existing
    ? await backupExistingResource(
        destination.resolvedPath,
        input.locationId,
        input.slug,
        backupId,
        deps
      )
    : undefined;

  const suffix = deps.randomSuffix();
  const stagePath = join(
    dirname(destination.resolvedPath),
    `.${basename(destination.resolvedPath)}.${suffix}.staging`
  );
  const previousPath = join(
    dirname(destination.resolvedPath),
    `.${basename(destination.resolvedPath)}.${suffix}.previous`
  );

  try {
    await deps.fs.copyTree(input.sourceDir, stagePath, 'stage');
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

async function backupExistingResource(
  destinationPath: string,
  locationId: LibraryLocationId,
  slug: string,
  backupId: string,
  deps: ResourceWriterDeps
): Promise<string> {
  const backupRoot = deps.backupDir();
  const backupPath = join(backupRoot, backupId, locationId, slug);
  await deps.fs.mkdir(dirname(backupPath));
  await deps.fs.copyTree(destinationPath, backupPath, 'backup');
  await pruneBackupSets(backupRoot, backupId, deps);
  return backupPath;
}

interface BackupSet {
  readonly id: string;
  readonly path: string;
  readonly modifiedAtMs: number;
}

/**
 * Recognizes a directory as a prunable backup set only when it has the
 * `<backupId>/<locationId>/<slug>` shape this writer creates. A misconfigured
 * `library.backupDir` pointing at a shared directory must never make retention
 * delete unrelated data, and a set that vanished mid-prune is simply skipped.
 */
async function describeBackupSet(
  id: string,
  path: string,
  fs: ResourceWriterFs
): Promise<BackupSet | null> {
  try {
    const entries = await fs.readdir(path);
    const holdsLocation = entries.some(
      (entry) => entry.isDirectory() && getLibraryLocation(entry.name as LibraryLocationId)
    );
    if (!holdsLocation) return null;
    return { id, path, modifiedAtMs: (await fs.stat(path)).mtimeMs };
  } catch {
    return null;
  }
}

async function pruneBackupSets(
  backupRoot: string,
  currentBackupId: string,
  deps: ResourceWriterDeps
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await deps.fs.readdir(backupRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => describeBackupSet(entry.name, join(backupRoot, entry.name), deps.fs))
  );
  const backupSets = candidates.filter((backup): backup is BackupSet => backup !== null);
  backupSets.sort(
    (left, right) => right.modifiedAtMs - left.modifiedAtMs || right.id.localeCompare(left.id)
  );

  const retentionCount = deps.backupRetentionCount();
  const retained = new Set([
    currentBackupId,
    ...backupSets
      .filter((backup) => backup.id !== currentBackupId)
      .slice(0, Math.max(0, retentionCount - 1))
      .map((backup) => backup.id),
  ]);
  await Promise.all(
    backupSets
      .filter((backup) => !retained.has(backup.id))
      .map((backup) => deps.fs.remove(backup.path))
  );
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

function createBackupId(deps: ResourceWriterDeps): string {
  return `${deps.now().toISOString().replaceAll(':', '-')}-${deps.randomSuffix()}`;
}

function assertBackupId(backupId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(backupId)) {
    throw new TypeError(`Invalid library backup id: "${backupId}".`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
