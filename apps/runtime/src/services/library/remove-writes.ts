/**
 * Filesystem execution for a prepared library removal: backup, stage aside,
 * verify gone, persist the manifest, then commit staged trees. Preview tokens,
 * last-copy acknowledgements, and planning stay on the hub.
 */

import { resolve as resolvePath } from 'node:path';
import type {
  RemovalApply,
  RemovalFailure,
  RemovalKept,
  RemovalRemoved,
} from '@mangostudio/shared/library';
import type { LocationDefinition } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import {
  type BackupEntry,
  type BackupStoreDeps,
  backupExistingResource,
  createBackupId,
  createBackupStoreDeps,
  discardBackupSet,
  pruneBackupSets,
  writeBackupManifest,
} from './backup-store';
import { assertNotCancelled } from './cancellation';
import { hashResourceAt } from './instance-reader';
import { assertExpectedResourceEntry } from './path-safety';
import { requireWritableLocation, resolveResourceDestination } from './resource-writer';
import {
  nodeTreeRemovalFs,
  type StagedRemoval,
  stageResourceRemoval,
  type TreeRemovalFs,
} from './tree-removal';

export interface PreparedRemovalOperation {
  readonly resourceKey: string;
  readonly locationId: string;
  readonly slug: string;
  readonly kind: 'file' | 'directory';
  readonly expectedPath: string;
  readonly expectedContentHash: string;
  readonly lastCopy: boolean;
}

export interface RemovalWriteEngineDeps {
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
  treeFs: TreeRemovalFs;
}

export interface ExecuteRemovalWritesParams {
  readonly backupRoot: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
  readonly pathEnv: PathEnv;
  readonly backupId?: string;
  readonly operations: readonly PreparedRemovalOperation[];
  readonly kept?: readonly RemovalKept[];
  readonly lastCopyResourceKeys?: readonly string[];
  /**
   * Aborts between operations, so the hub's RPC deadline actually stops the
   * staging loop instead of leaving it to remove every remaining copy after the
   * hub has already told the user the removal failed.
   */
  readonly signal?: AbortSignal;
}

export function createRemovalWriteEngineDeps(
  options: {
    readonly backupRoot: string | (() => string);
    readonly retentionCount?: number | (() => number);
    readonly retentionBytes?: number | (() => number);
  },
  overrides: Partial<RemovalWriteEngineDeps> = {}
): RemovalWriteEngineDeps {
  return {
    hashAt: overrides.hashAt ?? hashResourceAt,
    backup: overrides.backup ?? createBackupStoreDeps(options),
    treeFs: overrides.treeFs ?? nodeTreeRemovalFs,
  };
}

export async function executeRemovalWrites(
  params: ExecuteRemovalWritesParams,
  deps: RemovalWriteEngineDeps = createRemovalWriteEngineDeps({
    backupRoot: params.backupRoot,
    retentionCount: params.retentionCount,
    retentionBytes: params.retentionBytes,
  })
): Promise<RemovalApply> {
  const env = params.pathEnv;
  const backupId = params.backupId ?? createBackupId(deps.backup);
  const kept = params.kept ?? [];
  const lastCopyResourceKeys = params.lastCopyResourceKeys ?? [];
  const results: StagedOperation[] = [];
  const failed: RemovalFailure[] = [];

  for (const operation of params.operations) {
    try {
      assertNotCancelled(params.signal);
      results.push(await stageOperation(operation, env, backupId, deps));
    } catch (error) {
      failed.push(describeFailure(operation, error));
      break;
    }
  }

  const staged = results.map((result) => result.staged);
  const entries = results.map((result) => result.entry);
  const removed = results.map((result) => result.removed);

  if (failed.length > 0) {
    const unattempted = notAttempted(params.operations, results.length);
    const unrestored = await rollback(staged);
    const keptAll = [...kept, ...rolledBack(results, unrestored), ...unattempted];
    if (unrestored.size === 0) {
      await discardBackupSet(backupId, deps.backup).catch(() => undefined);
      return { partial: false, removed: [], kept: keptAll, failed };
    }
    await persistManifest(backupId, entries, lastCopyResourceKeys, deps);
    return {
      partial: true,
      removed: stillRemoved(results, unrestored),
      kept: keptAll,
      failed,
      backupId,
    };
  }

  if (entries.length === 0) {
    return { partial: false, removed, kept: [...kept], failed };
  }

  try {
    await persistManifest(backupId, entries, lastCopyResourceKeys, deps);
  } catch (error) {
    const unrestored = await rollback(staged);
    if (unrestored.size === 0) await discardBackupSet(backupId, deps.backup).catch(() => undefined);
    failed.push({
      resourceKey: params.operations[0]?.resourceKey ?? '',
      locationId: params.operations[0]?.locationId ?? '',
      reason: 'remove-failed',
      message: `Could not record the backup manifest, so this removal cannot be undone automatically; the copies are under backup set "${backupId}": ${errorMessage(error)}`,
    });
    const keptAll = [...kept, ...rolledBack(results, unrestored)];
    return unrestored.size === 0
      ? { partial: false, removed: [], kept: keptAll, failed }
      : {
          partial: true,
          removed: stillRemoved(results, unrestored),
          kept: keptAll,
          failed,
        };
  }

  for (const stage of staged) {
    await stage.commit().catch((error: unknown) => {
      console.error(`[library] Could not clean up "${stage.stagePath}":`, error);
    });
  }
  await pruneBackupSets(backupId, deps.backup);

  return { backupId, partial: false, removed, kept: [...kept], failed };
}

async function persistManifest(
  backupId: string,
  entries: readonly BackupEntry[],
  lastCopyResourceKeys: readonly string[],
  deps: RemovalWriteEngineDeps
): Promise<void> {
  await writeBackupManifest(
    {
      version: 2,
      backupId,
      createdAtMs: deps.backup.now().getTime(),
      entries: [...entries],
      operation: 'removal',
      ...(lastCopyResourceKeys.length > 0 && {
        pinned: true,
        lastCopyResourceKeys: [...lastCopyResourceKeys],
      }),
    },
    deps.backup
  );
}

interface StagedOperation {
  readonly staged: StagedRemoval;
  readonly entry: BackupEntry;
  readonly removed: RemovalRemoved;
}

async function stageOperation(
  operation: PreparedRemovalOperation,
  env: PathEnv,
  backupId: string,
  deps: RemovalWriteEngineDeps
): Promise<StagedOperation> {
  const location = requireWritableLocation(
    operation.locationId,
    operation.kind === 'directory' ? 'directory-of-dirs' : 'file'
  );
  const destination = resolveResourceDestination(location, operation.slug, env);
  assertPreviewedPath(operation, location, destination.logicalPath);
  assertExpectedResourceEntry(destination.resolvedPath, operation.kind);

  const contentHash = await deps.hashAt(destination.resolvedPath, operation.kind);
  if (contentHash !== operation.expectedContentHash) {
    throw new GuardError(
      `"${destination.logicalPath}" hashed to ${contentHash}, not the ${operation.expectedContentHash} the preview described.`
    );
  }

  let backupPath: string;
  try {
    backupPath = await backupExistingResource(
      {
        resolvedPath: destination.resolvedPath,
        locationId: location.id,
        slug: operation.slug,
        backupId,
      },
      deps.backup
    );
  } catch (error) {
    throw new BackupError(`Could not back up "${destination.logicalPath}": ${errorMessage(error)}`);
  }

  const staged = await stageResourceRemoval(
    { resolvedPath: destination.resolvedPath, suffix: deps.backup.randomSuffix() },
    deps.treeFs
  );

  return {
    staged,
    entry: {
      locationId: location.id,
      slug: operation.slug,
      kind: operation.kind,
      destinationPath: destination.logicalPath,
      resolvedPath: destination.resolvedPath,
      backupPath,
      resourceKey: operation.resourceKey,
      writtenContentHash: contentHash,
    },
    removed: {
      resourceKey: operation.resourceKey,
      locationId: location.id,
      path: destination.logicalPath,
      contentHash,
      lastCopy: operation.lastCopy,
    },
  };
}

function assertPreviewedPath(
  operation: PreparedRemovalOperation,
  location: LocationDefinition,
  logicalPath: string
): void {
  if (resolvePath(logicalPath) === resolvePath(operation.expectedPath)) return;
  throw new GuardError(
    `"${operation.resourceKey}" resolves to "${logicalPath}" at "${location.id}", not the previewed "${operation.expectedPath}".`
  );
}

async function rollback(staged: readonly StagedRemoval[]): Promise<ReadonlySet<string>> {
  const unrestored = new Set<string>();
  for (const stage of [...staged].reverse()) {
    try {
      await stage.rollback();
    } catch (error) {
      unrestored.add(stage.stagePath);
      console.error(`[library] Could not restore "${stage.resolvedPath}":`, error);
    }
  }
  return unrestored;
}

function stillRemoved(
  results: readonly StagedOperation[],
  unrestored: ReadonlySet<string>
): RemovalRemoved[] {
  return results
    .filter((result) => unrestored.has(result.staged.stagePath))
    .map((result) => result.removed);
}

function rolledBack(
  results: readonly StagedOperation[],
  unrestored: ReadonlySet<string>
): RemovalKept[] {
  return results
    .filter((result) => !unrestored.has(result.staged.stagePath))
    .map((result) => ({
      resourceKey: result.removed.resourceKey,
      locationId: result.removed.locationId,
      reason: 'rolled-back' as const,
    }));
}

function notAttempted(
  operations: readonly PreparedRemovalOperation[],
  staged: number
): RemovalKept[] {
  return operations.slice(staged + 1).map((operation) => ({
    resourceKey: operation.resourceKey,
    locationId: operation.locationId,
    reason: 'not-attempted' as const,
  }));
}

class GuardError extends Error {}
class BackupError extends Error {}

function describeFailure(operation: PreparedRemovalOperation, error: unknown): RemovalFailure {
  const reason =
    error instanceof GuardError
      ? 'guard-rejected'
      : error instanceof BackupError
        ? 'backup-failed'
        : error instanceof Error && error.name === 'LibraryWriteError'
          ? 'guard-rejected'
          : error instanceof Error && error.name === 'RemovalVerificationError'
            ? 'verification-failed'
            : 'remove-failed';
  return {
    resourceKey: operation.resourceKey,
    locationId: operation.locationId,
    reason,
    message: errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
