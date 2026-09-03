/**
 * Filesystem execution for a prepared library removal: backup, stage aside,
 * verify gone, persist the manifest, then commit staged trees. Preview tokens,
 * last-copy acknowledgements, and planning stay on the hub.
 *
 * The hub's own `kept` entries are not part of the exchange: it decided them
 * while planning and already holds them. The result carries only what this
 * engine kept — rolled back or never attempted — and the hub merges.
 */

import { resolve as resolvePath } from 'node:path';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  RemovalApply,
  RemovalFailure,
  RemovalKept,
  RemovalRemoved,
} from '@mangostudio/shared/library';
import type { LocationDefinition } from '@mangostudio/shared/library/host';
import type { LibraryPathEnv, PathEnv } from '@mangostudio/shared/runtime-env';
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
import type { PreparedRemovalOperation } from './write-shapes';

export interface RemovalWriteEngineDeps {
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
  treeFs: TreeRemovalFs;
}

export interface ExecuteRemovalWritesParams {
  readonly backupRoot: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
  readonly pathEnv: LibraryPathEnv;
  readonly backupId?: string;
  readonly operations: readonly PreparedRemovalOperation[];
  readonly lastCopyResourceKeys?: readonly string[];
  /** Stamped into the manifest so a store can name the environment it serves. */
  readonly environmentId?: string;
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
  // Echoed onto every row from the envelope; see `apply-writes.ts`.
  const environmentId = params.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const backupId = params.backupId ?? createBackupId(deps.backup);
  const lastCopyResourceKeys = params.lastCopyResourceKeys ?? [];
  const results: StagedOperation[] = [];
  const failed: RemovalFailure[] = [];

  for (const operation of params.operations) {
    try {
      assertNotCancelled(params.signal);
      results.push(await stageOperation(operation, env, backupId, environmentId, deps));
    } catch (error) {
      failed.push(describeFailure(operation, environmentId, error));
      break;
    }
  }

  const staged = results.map((result) => result.staged);
  const entries = results.map((result) => result.entry);
  const removed = results.map((result) => result.removed);
  const handles = [{ environmentId, backupId }];

  if (failed.length > 0) {
    const unattempted = notAttempted(params.operations, environmentId, results.length);
    const unrestored = await rollback(staged);
    const keptAll = [...rolledBack(results, unrestored), ...unattempted];
    if (unrestored.size === 0) {
      await discardBackupSet(backupId, deps.backup).catch(() => undefined);
      return { partial: false, removed: [], kept: keptAll, failed, backups: [] };
    }
    await persistManifest(backupId, entries, lastCopyResourceKeys, params.environmentId, deps);
    return {
      partial: true,
      removed: stillRemoved(results, unrestored),
      kept: keptAll,
      failed,
      backupId,
      backups: handles,
    };
  }

  if (entries.length === 0) {
    return { partial: false, removed, kept: [], failed, backups: [] };
  }

  try {
    await persistManifest(backupId, entries, lastCopyResourceKeys, params.environmentId, deps);
  } catch (error) {
    const unrestored = await rollback(staged);
    if (unrestored.size === 0) await discardBackupSet(backupId, deps.backup).catch(() => undefined);
    failed.push({
      resourceKey: params.operations[0]?.resourceKey ?? '',
      environmentId,
      locationId: params.operations[0]?.locationId ?? '',
      reason: 'remove-failed',
      message: `Could not record the backup manifest, so this removal cannot be undone automatically; the copies are under backup set "${backupId}": ${errorMessage(error)}`,
    });
    const keptAll = [...rolledBack(results, unrestored)];
    // No handle either way on this path. The manifest is what `undo` resolves,
    // and it is the thing that just failed to be written — naming the set would
    // put a restore button on screen that answers 404. The failure message
    // above still names the directory, which is the only honest handle left.
    return unrestored.size === 0
      ? { partial: false, removed: [], kept: keptAll, failed, backups: [] }
      : {
          partial: true,
          removed: stillRemoved(results, unrestored),
          kept: keptAll,
          failed,
          backups: [],
        };
  }

  for (const stage of staged) {
    await stage.commit().catch((error: unknown) => {
      console.error(`[library] Could not clean up "${stage.stagePath}":`, error);
    });
  }
  await pruneBackupSets(backupId, deps.backup);

  return { backupId, backups: handles, partial: false, removed, kept: [], failed };
}

async function persistManifest(
  backupId: string,
  entries: readonly BackupEntry[],
  lastCopyResourceKeys: readonly string[],
  environmentId: string | undefined,
  deps: RemovalWriteEngineDeps
): Promise<void> {
  await writeBackupManifest(
    {
      version: 3,
      backupId,
      createdAtMs: deps.backup.now().getTime(),
      entries: [...entries],
      operation: 'removal',
      ...(environmentId !== undefined && { environmentId }),
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
  environmentId: string,
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
      environmentId,
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
      environmentId: result.removed.environmentId,
      locationId: result.removed.locationId,
      reason: 'rolled-back' as const,
    }));
}

function notAttempted(
  operations: readonly PreparedRemovalOperation[],
  environmentId: string,
  staged: number
): RemovalKept[] {
  return operations.slice(staged + 1).map((operation) => ({
    resourceKey: operation.resourceKey,
    environmentId,
    locationId: operation.locationId,
    reason: 'not-attempted' as const,
  }));
}

class GuardError extends Error {}
class BackupError extends Error {}

function describeFailure(
  operation: PreparedRemovalOperation,
  environmentId: string,
  error: unknown
): RemovalFailure {
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
    environmentId,
    locationId: operation.locationId,
    reason,
    message: errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
