/**
 * Restores every path an apply backed up and removes every path it created.
 *
 * Shared by propagation and removal undo. A destination that changed after the
 * apply is left alone rather than reverted: undoing must not also discard an
 * edit the user made afterwards.
 */

import { resolve as resolvePath } from 'node:path';
import type { LibraryUndoResult } from '@mangostudio/shared/library';
import { getLibraryLocation } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { isPathPrefix, resolvePathThroughExistingAncestor } from '../path-containment';
import {
  type BackupEntry,
  type BackupStoreDeps,
  createBackupStoreDeps,
  readBackupManifest,
  restoreBackupEntry,
} from './backup-store';
import { assertNotCancelled } from './cancellation';
import { hashResourceAt } from './instance-reader';
import { LibraryWriteError } from './path-safety';

export interface LibraryUndoEngineDeps {
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
}

export interface ExecuteLibraryUndoParams {
  readonly backupRoot: string;
  readonly backupId: string;
  /** Resolves the registry roots every touched path has to sit inside. */
  readonly pathEnv: PathEnv;
  /**
   * Aborts between entries. An undo that keeps restoring after the hub gave up
   * on it leaves the user looking at a failure while the tree changes under
   * them; stopping here means the entries not yet reached simply stay as they
   * are, which the report already describes.
   */
  readonly signal?: AbortSignal;
}

export function createLibraryUndoEngineDeps(
  options: {
    readonly backupRoot: string | (() => string);
  },
  overrides: Partial<LibraryUndoEngineDeps> = {}
): LibraryUndoEngineDeps {
  return {
    hashAt: overrides.hashAt ?? hashResourceAt,
    backup: overrides.backup ?? createBackupStoreDeps(options),
  };
}

export async function executeLibraryUndo(
  params: ExecuteLibraryUndoParams,
  deps: LibraryUndoEngineDeps = createLibraryUndoEngineDeps({ backupRoot: params.backupRoot })
): Promise<LibraryUndoResult> {
  // `readBackupManifest` returns null for a genuinely absent set (ENOENT) and
  // for an unparseable manifest. I/O failures other than ENOENT propagate so a
  // permission error is not reported as "pruned by retention". Malformed ids
  // still throw TypeError from `backupSetPath`; map those to the same missing
  // outcome the hub turns into a 404.
  let manifest: Awaited<ReturnType<typeof readBackupManifest>> = null;
  try {
    manifest = await readBackupManifest(params.backupId, deps.backup);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  if (!manifest) {
    throw new LibraryBackupMissingError(
      `No library backup "${params.backupId}" is retained. Backups are bounded by count and size.`
    );
  }

  const backupRoot = resolvePath(deps.backup.backupDir());
  const restored: LibraryUndoResult['restored'] = [];
  const removed: LibraryUndoResult['removed'] = [];
  const skipped: LibraryUndoResult['skipped'] = [];

  for (const entry of [...manifest.entries].reverse()) {
    assertNotCancelled(params.signal);
    assertContainedInLocation(entry, params.pathEnv);
    const location = { locationId: entry.locationId, destinationPath: entry.destinationPath };
    const currentHash = await deps.hashAt(entry.resolvedPath, entry.kind).catch(() => null);
    if (currentHash !== null && currentHash !== entry.writtenContentHash) {
      skipped.push({ ...location, reason: 'changed-since-apply' });
      continue;
    }

    if (!entry.backupPath) {
      await deps.backup.fs.remove(entry.resolvedPath);
      removed.push(location);
      continue;
    }
    // The manifest is untrusted input on this side of the protocol: it is a
    // JSON file under a caller-supplied root, so a hand-edited `backupPath`
    // would otherwise make the restore copy an arbitrary tree onto the
    // destination. Every path this module writes lives under the backup root.
    if (!isPathPrefix(backupRoot, resolvePath(entry.backupPath))) {
      skipped.push({ ...location, reason: 'backup-missing' });
      continue;
    }
    if (!(await deps.backup.fs.lstat(entry.backupPath))) {
      skipped.push({ ...location, reason: 'backup-missing' });
      continue;
    }
    await restoreBackupEntry(entry, deps.backup);
    restored.push(location);
  }

  return { backupId: params.backupId, restored, removed, skipped };
}

/**
 * Refuses an entry whose destination is not inside the registry location it
 * claims, resolved from this host's own `PathEnv`.
 *
 * The manifest is untrusted on this side of the protocol: it is a JSON file
 * under a caller-supplied `backupRoot`, and the entry it describes drives an
 * `rm -rf` (`fs.remove`, `recursive`, `force`) or an overwriting tree copy. A
 * hand-written entry naming `/etc` would otherwise be executed verbatim, which
 * is what made this engine a confused deputy once it became an RPC surface
 * rather than in-process hub code writing to hub-owned config.
 *
 * The whole undo refuses rather than skipping the entry: a manifest this engine
 * wrote can never trip the check, so tripping it means the set is corrupt or
 * forged, and partially undoing a corrupt set is the worse outcome.
 */
function assertContainedInLocation(entry: BackupEntry, env: PathEnv): void {
  const location = getLibraryLocation(entry.locationId);
  const root = location?.resolvePath(env) ?? null;
  if (root === null) {
    throw new LibraryWriteError(
      'unsupported-location',
      `Library backup entry names location "${entry.locationId}", which does not resolve on this machine.`
    );
  }
  // Equality is allowed: a `single-file` location is itself the destination.
  if (!isPathPrefix(resolvePathThroughExistingAncestor(root), resolvePath(entry.resolvedPath))) {
    throw new LibraryWriteError(
      'path-escape',
      `Library backup entry points at "${entry.resolvedPath}", which is outside location "${entry.locationId}".`
    );
  }
}

/** Raised when undo names a backup set that is gone or never existed. */
export class LibraryBackupMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryBackupMissingError';
  }
}
