/**
 * Restores every path an apply backed up and removes every path it created.
 *
 * Shared by propagation and removal undo. A destination that changed after the
 * apply is left alone rather than reverted: undoing must not also discard an
 * edit the user made afterwards.
 */

import type { PropagationUndo } from '@mangostudio/shared/library';
import {
  type BackupStoreDeps,
  createBackupStoreDeps,
  readBackupManifest,
  restoreBackupEntry,
} from './backup-store';
import { hashResourceAt } from './instance-reader';

export interface LibraryUndoEngineDeps {
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
}

export interface ExecuteLibraryUndoParams {
  readonly backupRoot: string;
  readonly backupId: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
}

export function createLibraryUndoEngineDeps(
  options: {
    readonly backupRoot: string | (() => string);
    readonly retentionCount?: number | (() => number);
    readonly retentionBytes?: number | (() => number);
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
  deps: LibraryUndoEngineDeps = createLibraryUndoEngineDeps({
    backupRoot: params.backupRoot,
    retentionCount: params.retentionCount,
    retentionBytes: params.retentionBytes,
  })
): Promise<PropagationUndo> {
  const manifest = await readBackupManifest(params.backupId, deps.backup).catch(() => null);
  if (!manifest) {
    throw new LibraryBackupMissingError(
      `No library backup "${params.backupId}" is retained. Backups are bounded by count and size.`
    );
  }

  const restored: PropagationUndo['restored'] = [];
  const removed: PropagationUndo['removed'] = [];
  const skipped: PropagationUndo['skipped'] = [];

  for (const entry of [...manifest.entries].reverse()) {
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
    if (!(await deps.backup.fs.lstat(entry.backupPath))) {
      skipped.push({ ...location, reason: 'backup-missing' });
      continue;
    }
    await restoreBackupEntry(entry, deps.backup);
    restored.push(location);
  }

  return { backupId: params.backupId, restored, removed, skipped };
}

/** Raised when undo names a backup set that is gone or never existed. */
export class LibraryBackupMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryBackupMissingError';
  }
}
