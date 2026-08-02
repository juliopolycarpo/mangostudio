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
import type {
  BackupSetOperation,
  LibraryLocationId,
  PropagationBackupSet,
} from '@mangostudio/shared/library';
import { getLibraryLocation } from '@mangostudio/shared/library/host';
import { getConfig } from '../../../lib/config';

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
  /**
   * Manifest v2. The identity the coverage matrix uses, so a listed set can name
   * what it holds instead of counting anonymous entries. Absent on entries
   * written before v2 — `slug` is what the writer needed, and a slug alone
   * cannot be turned back into a resource key.
   */
  readonly resourceKey?: string;
}

export interface BackupManifest {
  readonly version: 1 | 2;
  readonly backupId: string;
  readonly createdAtMs: number;
  readonly entries: BackupEntry[];
  /**
   * Set holds the last remaining copy of a resource, so retention never evicts
   * it. Optional rather than a version bump: a manifest written before pinning
   * existed is simply an unpinned one, and an undo of it must keep working.
   */
  readonly pinned?: boolean;
  /** Resources this set is the only remaining copy of, for the disclosure UI. */
  readonly lastCopyResourceKeys?: string[];
  /**
   * Manifest v2. Which flow wrote this set, because undo means opposite things
   * either way: a removal set restores content, and a propagation set that
   * created paths deletes them. Recorded rather than inferred — a propagation
   * apply that only overwrote pre-existing files produces entries
   * indistinguishable from a removal's, and that is exactly the case where a
   * wrong guess deletes a file.
   *
   * Absent on a v1 manifest, which lists as `unknown` rather than as a guess.
   */
  readonly operation?: Exclude<BackupSetOperation, 'unknown'>;
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

/**
 * `async` on purpose: `backupSetPath` rejects a malformed id by throwing, and
 * callers reach for `.catch()` to turn "no such backup" into a 404. Throwing
 * synchronously would route a caller-supplied bad id past that catch and out as
 * an unexpected 500 instead.
 */
export async function readBackupManifest(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<BackupManifest | null> {
  return await readManifestAt(backupSetPath(backupId, deps), deps.fs);
}

async function readManifestAt(setPath: string, fs: BackupStoreFs): Promise<BackupManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(join(setPath, MANIFEST_NAME));
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
 * while staging leaves the original rather than half of it. `resolvedPath`
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
  } catch (error) {
    await deps.fs.remove(stagePath).catch(() => undefined);
    throw error;
  }
  // Past this point the destination is already gone, so the staged copy is the
  // closest thing to it that exists locally. Discarding it on a failed rename
  // would turn "the restore did not finish" into "the destination vanished".
  await deps.fs.remove(entry.resolvedPath);
  await deps.fs.rename(stagePath, entry.resolvedPath);
}

export async function discardBackupSet(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  await deps.fs.remove(backupSetPath(backupId, deps));
}

/**
 * Deletes a retained set on the user's say-so, reporting whether it was there.
 *
 * The explicit counterpart to pinning: a set holding someone's only copy of a
 * skill is never evicted automatically, so there has to be a way to say "yes,
 * really, let it go" — and a purge of something already gone is the state the
 * caller asked for, not an error, which is why the boolean is informational.
 */
export async function purgeBackupSet(
  backupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<boolean> {
  const path = backupSetPath(backupId, deps);
  const existed = (await deps.fs.lstat(path)) !== null;
  await deps.fs.remove(path);
  return existed;
}

interface BackupSet {
  readonly id: string;
  readonly path: string;
  readonly modifiedAtMs: number;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
  readonly entryCount: number;
  readonly pinned: boolean;
  readonly lastCopyResourceKeys: string[];
  readonly operation: BackupSetOperation;
  readonly resourceKeys: string[];
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
    const hasManifest = entries.some((entry) => entry.isFile() && entry.name === MANIFEST_NAME);
    const isBackupSet =
      hasManifest || entries.some((entry) => entry.isDirectory() && getLibraryLocation(entry.name));
    if (!isBackupSet) return null;

    const stats = await fs.stat(path);
    // A set whose manifest is missing or unreadable is still a real backup
    // directory, and still costs disk. It is reported unpinned rather than
    // hidden — pinning is a property the manifest carries, not an assumption.
    const manifest = hasManifest ? await readManifestAt(path, fs) : null;
    return {
      id,
      path,
      modifiedAtMs: stats.mtimeMs,
      sizeBytes: await directorySize(path, fs),
      createdAtMs: manifest?.createdAtMs ?? Math.round(stats.mtimeMs),
      entryCount: manifest?.entries.length ?? 0,
      pinned: manifest?.pinned === true,
      lastCopyResourceKeys: manifest?.lastCopyResourceKeys ?? [],
      // A v1 manifest, or none at all, reports `unknown`. The alternative would
      // be reading the entries and guessing, which is unsound in exactly the
      // case where being wrong labels a delete as a restore.
      operation: manifest?.operation ?? 'unknown',
      resourceKeys: distinctResourceKeys(manifest),
    };
  } catch {
    return null;
  }
}

/**
 * Every resource the set holds, deduped and ordered so two reads of one set
 * render the same list. Empty for a v1 manifest: its entries carry a slug, and
 * a slug does not identify a resource on its own.
 */
function distinctResourceKeys(manifest: BackupManifest | null): string[] {
  const keys = new Set<string>();
  for (const entry of manifest?.entries ?? []) {
    if (entry.resourceKey) keys.add(entry.resourceKey);
  }
  return [...keys].sort();
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
 * Every retained set, newest first. Returns an empty list rather than throwing
 * when the backup root does not exist yet, because "nothing retained" is the
 * normal state before the first apply.
 */
async function collectBackupSets(deps: BackupStoreDeps): Promise<BackupSet[]> {
  const backupRoot = deps.backupDir();
  let entries: Dirent[];
  try {
    entries = await deps.fs.readdir(backupRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => describeBackupSet(entry.name, join(backupRoot, entry.name), deps.fs))
  );
  return candidates
    .filter((backup): backup is BackupSet => backup !== null)
    .sort(
      (left, right) => right.modifiedAtMs - left.modifiedAtMs || right.id.localeCompare(left.id)
    );
}

/**
 * Trims retained sets to both bounds, newest first. Count alone is not enough:
 * a handful of large skill directories can outgrow anything a user expected a
 * backup folder to cost.
 *
 * Pinned sets sit outside both bounds. They are retained unconditionally and
 * their bytes are charged first, so they squeeze ordinary sets out rather than
 * being squeezed out themselves. Evicting the only copy of a user's skill to
 * reclaim disk is not a trade the app gets to make silently — the way to
 * reclaim it is `purgeBackupSet`, which the user asks for.
 */
export async function pruneBackupSets(
  currentBackupId: string,
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<void> {
  const backupSets = await collectBackupSets(deps);
  if (backupSets.length === 0) return;

  const retentionCount = deps.retentionCount();
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1) {
    throw new TypeError('Library backup retention count must be a positive integer.');
  }

  const retained = selectRetained(backupSets, currentBackupId, retentionCount, deps);
  await Promise.all(
    backupSets
      .filter((backup) => !retained.has(backup.id))
      .map((backup) => deps.fs.remove(backup.path))
  );
}

/**
 * The sets retention keeps, given the list newest first.
 *
 * Extracted so the rule has exactly one definition: `pruneBackupSets` deletes
 * what it excludes, and `listBackupSets` marks the same sets as evicting next.
 * Two copies of a retention rule that disagree is a user being told their backup
 * is safe on the render before it disappears.
 *
 * `currentBackupId` is the set an apply just wrote, retained unconditionally
 * because dropping it would leave the caller holding a backup id that cannot be
 * undone. A projection has no such set and passes null — it answers "if
 * retention ran right now, what goes".
 */
function selectRetained(
  backupSets: readonly BackupSet[],
  currentBackupId: string | null,
  retentionCount: number,
  deps: BackupStoreDeps
): ReadonlySet<string> {
  const retained = new Set<string>();
  if (currentBackupId !== null) retained.add(currentBackupId);

  let retainedBytes = 0;
  for (const backup of backupSets) {
    if (!backup.pinned) continue;
    retained.add(backup.id);
    retainedBytes += backup.sizeBytes;
  }

  const current = backupSets.find((backup) => backup.id === currentBackupId);
  if (current && !current.pinned) retainedBytes += current.sizeBytes;
  let ordinaryCount = current && !current.pinned ? 1 : 0;

  for (const backup of backupSets) {
    if (retained.has(backup.id)) continue;
    if (ordinaryCount >= retentionCount) break;
    if (retainedBytes + backup.sizeBytes > deps.retentionBytes()) break;
    retained.add(backup.id);
    retainedBytes += backup.sizeBytes;
    ordinaryCount += 1;
  }
  return retained;
}

/**
 * What backups cost, set by set, and which of them retention is about to take.
 *
 * Listed rather than only totalled so a pinned set — which nothing will ever
 * evict — can be seen and sized, and so "why is this directory large" has an
 * answer that names the culprit. `evictsNext` is computed here, beside the
 * budget math it has to agree with, rather than re-derived by a caller.
 *
 * A retention count too small to keep anything is not rejected the way a prune
 * rejects it: this path deletes nothing, and refusing to render the list is a
 * worse answer than reporting every ordinary set as evicting, which is what a
 * budget of zero honestly means.
 */
export async function listBackupSets(
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<PropagationBackupSet[]> {
  const backupSets = await collectBackupSets(deps);
  const retained = selectRetained(backupSets, null, deps.retentionCount(), deps);
  return backupSets.map((backup) => ({
    backupId: backup.id,
    createdAtMs: backup.createdAtMs,
    sizeBytes: backup.sizeBytes,
    entryCount: backup.entryCount,
    pinned: backup.pinned,
    lastCopyResourceKeys: backup.lastCopyResourceKeys,
    operation: backup.operation,
    resourceKeys: backup.resourceKeys,
    evictsNext: !retained.has(backup.id),
  }));
}

/**
 * Both versions read. A v1 manifest is one written before `operation` and
 * per-entry `resourceKey` existed, and its undo has to keep working exactly as
 * it did — backups are files on disk, so there is no migration and nothing to
 * backfill. Rejecting it would strand the copies it points at.
 */
function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BackupManifest>;
  return (
    (candidate.version === 1 || candidate.version === 2) &&
    typeof candidate.backupId === 'string' &&
    typeof candidate.createdAtMs === 'number' &&
    (candidate.pinned === undefined || typeof candidate.pinned === 'boolean') &&
    (candidate.operation === undefined ||
      candidate.operation === 'propagation' ||
      candidate.operation === 'removal') &&
    (candidate.lastCopyResourceKeys === undefined ||
      (Array.isArray(candidate.lastCopyResourceKeys) &&
        candidate.lastCopyResourceKeys.every((key) => typeof key === 'string'))) &&
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
    (candidate.backupPath === undefined || typeof candidate.backupPath === 'string') &&
    (candidate.resourceKey === undefined || typeof candidate.resourceKey === 'string')
  );
}
