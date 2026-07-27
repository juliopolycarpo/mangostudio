/**
 * Recoverable copies of everything a propagation apply replaces, plus the
 * manifest that makes an apply reversible.
 *
 * The whole feature asks users to let an app write into directories they care
 * about. A visible undo is what makes that a reasonable request, so an apply is
 * not considered shippable without the backup it can be rolled back from.
 */

import { randomBytes } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LibraryLocationId } from '@mangostudio/shared/library';
import { getConfig } from '../../../lib/config';
import { getLibraryLocation } from '../domain/registry';

export interface BackupEntry {
  readonly locationId: LibraryLocationId;
  readonly slug: string;
  readonly kind: 'file' | 'directory';
  /** Path as the registry names it, for display. */
  readonly destinationPath: string;
  /** Where the write actually landed, after symlink resolution. */
  readonly resolvedPath: string;
  /** Copy of the pre-write content; absent when the apply created the path. */
  readonly backupPath?: string;
  /** Hash the apply wrote, so undo can tell whether anything moved since. */
  readonly writtenContentHash: string;
}

export interface BackupManifest {
  readonly version: 1;
  readonly backupId: string;
  readonly createdAtMs: number;
  readonly entries: BackupEntry[];
}

interface BackupStoreFs {
  copyTree(source: string, destination: string): Promise<void>;
  lstat(path: string): Promise<Stats | null>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<Dirent[]>;
  readFile(path: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface BackupStoreDeps {
  readonly fs: BackupStoreFs;
  readonly backupDir: () => string;
  readonly retentionCount: () => number;
  readonly retentionBytes: () => number;
  readonly now: () => Date;
  readonly randomSuffix: () => string;
}

const nodeBackupStoreFs: BackupStoreFs = {
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
  readFile: (path) => readFile(path, 'utf8'),
  rename,
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  stat,
  writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
};

export const defaultBackupStoreDeps: BackupStoreDeps = {
  fs: nodeBackupStoreFs,
  backupDir: () => getConfig().library.backupDir,
  retentionCount: () => getConfig().library.backupRetentionCount,
  retentionBytes: () => getConfig().library.backupRetentionBytes,
  now: () => new Date(),
  randomSuffix: () => randomBytes(8).toString('hex'),
};

const MANIFEST_NAME = 'manifest.json';

/**
 * One path segment that cannot be `.` or `..`, so a caller-supplied id can
 * never move a backup outside the configured backup root.
 */
const BACKUP_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function createBackupId(deps: BackupStoreDeps = defaultBackupStoreDeps): string {
  return `${deps.now().toISOString().replaceAll(':', '-')}-${deps.randomSuffix()}`;
}

export function assertBackupId(backupId: string): void {
  if (!BACKUP_ID_PATTERN.test(backupId)) {
    throw new TypeError(`Invalid library backup id: "${backupId}".`);
  }
}

function backupSetPath(backupId: string, deps: BackupStoreDeps): string {
  assertBackupId(backupId);
  return join(deps.backupDir(), backupId);
}

/** Copies the current content of a destination aside before it is replaced. */
export async function backupExistingResource(
  input: {
    readonly resolvedPath: string;
    readonly locationId: LibraryLocationId;
    readonly slug: string;
    readonly backupId: string;
  },
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<string> {
  const backupPath = join(backupSetPath(input.backupId, deps), input.locationId, input.slug);
  await deps.fs.mkdir(dirname(backupPath));
  await deps.fs.copyTree(input.resolvedPath, backupPath);
  return backupPath;
}

export async function writeBackupManifest(
  manifest: BackupManifest,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  const setPath = backupSetPath(manifest.backupId, deps);
  await deps.fs.mkdir(setPath);
  await deps.fs.writeFile(join(setPath, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readBackupManifest(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<BackupManifest | null> {
  let raw: string;
  try {
    raw = await deps.fs.readFile(join(backupSetPath(backupId, deps), MANIFEST_NAME));
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Puts a backed-up copy back where it came from, atomically.
 *
 * The copy is staged beside the destination and renamed into place, so a failure
 * partway through leaves the original rather than half of it. `resolvedPath`
 * already points past any symlink — it was recorded after resolution during the
 * apply — so restoring writes through the link exactly as the write did.
 */
export async function restoreBackupEntry(
  entry: BackupEntry,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  if (!entry.backupPath) {
    throw new TypeError(`Backup entry for "${entry.destinationPath}" has nothing to restore.`);
  }

  const suffix = deps.randomSuffix();
  const stagePath = join(
    dirname(entry.resolvedPath),
    `.${basename(entry.resolvedPath)}.${suffix}.restore`
  );
  await deps.fs.mkdir(dirname(entry.resolvedPath));
  try {
    await deps.fs.copyTree(entry.backupPath, stagePath);
    await deps.fs.remove(entry.resolvedPath);
    await deps.fs.rename(stagePath, entry.resolvedPath);
  } catch (error) {
    await deps.fs.remove(stagePath).catch(() => undefined);
    throw error;
  }
}

export async function discardBackupSet(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  await deps.fs.remove(backupSetPath(backupId, deps));
}

interface BackupSet {
  readonly id: string;
  readonly path: string;
  readonly modifiedAtMs: number;
  readonly sizeBytes: number;
}

/**
 * Recognizes a directory as a prunable backup set only when it carries this
 * module's manifest or the `<backupId>/<locationId>/<slug>` shape it creates. A
 * misconfigured `library.backupDir` pointing at a shared directory must never
 * make retention delete unrelated data, and a set that vanished mid-prune is
 * simply skipped.
 */
async function describeBackupSet(
  id: string,
  path: string,
  fs: BackupStoreFs
): Promise<BackupSet | null> {
  try {
    const entries = await fs.readdir(path);
    const isBackupSet =
      entries.some((entry) => entry.isFile() && entry.name === MANIFEST_NAME) ||
      entries.some((entry) => entry.isDirectory() && getLibraryLocation(entry.name));
    if (!isBackupSet) return null;
    return {
      id,
      path,
      modifiedAtMs: (await fs.stat(path)).mtimeMs,
      sizeBytes: await directorySize(path, fs),
    };
  } catch {
    return null;
  }
}

async function directorySize(path: string, fs: BackupStoreFs): Promise<number> {
  const entries = await fs.readdir(path);
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return directorySize(entryPath, fs);
      if (!entry.isFile()) return 0;
      return (await fs.stat(entryPath)).size;
    })
  );
  return sizes.reduce((total, size) => total + size, 0);
}

/**
 * Trims retained sets to both bounds, newest first. Count alone is not enough:
 * a handful of large skill directories can outgrow anything a user expected a
 * backup folder to cost.
 */
export async function pruneBackupSets(
  currentBackupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  const backupRoot = deps.backupDir();
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

  const retentionCount = deps.retentionCount();
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1) {
    throw new TypeError('Library backup retention count must be a positive integer.');
  }

  // The set this apply just wrote is always retained: dropping it would leave
  // the caller holding a backup id that cannot be undone.
  const current = backupSets.find((backup) => backup.id === currentBackupId);
  const retained = new Set([currentBackupId]);
  let retainedBytes = current?.sizeBytes ?? 0;
  for (const backup of backupSets) {
    if (backup.id === currentBackupId) continue;
    if (retained.size >= retentionCount) break;
    if (retainedBytes + backup.sizeBytes > deps.retentionBytes()) break;
    retained.add(backup.id);
    retainedBytes += backup.sizeBytes;
  }

  await Promise.all(
    backupSets
      .filter((backup) => !retained.has(backup.id))
      .map((backup) => deps.fs.remove(backup.path))
  );
}

/** Total bytes currently held, so the UI can show what backups cost. */
export async function measureBackupUsage(
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<{ setCount: number; sizeBytes: number }> {
  const backupRoot = deps.backupDir();
  let entries: Dirent[];
  try {
    entries = await deps.fs.readdir(backupRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { setCount: 0, sizeBytes: 0 };
    throw error;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => describeBackupSet(entry.name, join(backupRoot, entry.name), deps.fs))
  );
  const backupSets = candidates.filter((backup): backup is BackupSet => backup !== null);
  return {
    setCount: backupSets.length,
    sizeBytes: backupSets.reduce((total, backup) => total + backup.sizeBytes, 0),
  };
}

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BackupManifest>;
  return (
    candidate.version === 1 &&
    typeof candidate.backupId === 'string' &&
    typeof candidate.createdAtMs === 'number' &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isBackupEntry)
  );
}

function isBackupEntry(value: unknown): value is BackupEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BackupEntry>;
  return (
    typeof candidate.locationId === 'string' &&
    typeof candidate.slug === 'string' &&
    (candidate.kind === 'file' || candidate.kind === 'directory') &&
    typeof candidate.destinationPath === 'string' &&
    typeof candidate.resolvedPath === 'string' &&
    typeof candidate.writtenContentHash === 'string' &&
    (candidate.backupPath === undefined || typeof candidate.backupPath === 'string')
  );
}
