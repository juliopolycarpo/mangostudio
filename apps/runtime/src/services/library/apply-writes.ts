/**
 * Filesystem execution for a prepared propagation apply: write, verify, backup
 * manifest, and compensate on failure. Planning, tokens, and format adapters
 * stay on the hub; this module only mutates the host that holds the files.
 *
 * `skipped` is not part of the exchange. The hub decides what to skip while
 * planning and already holds the list, so sending it here only to have it
 * echoed back would put it on the wire twice and give the engine a field to
 * keep in sync for no decision it makes. The result carries an empty array and
 * the hub merges its own.
 */

import { resolve as resolvePath } from 'node:path';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  LibraryLocationId,
  PropagationApplied,
  PropagationApply,
  PropagationFailure,
} from '@mangostudio/shared/library';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import {
  type BackupEntry,
  type BackupStoreDeps,
  createBackupId,
  createBackupStoreDeps,
  discardBackupSet,
  pruneBackupSets,
  restoreBackupEntry,
  writeBackupManifest,
} from './backup-store';
import { assertNotCancelled } from './cancellation';
import { hashResourceAt, LibraryHashInvalidError } from './instance-reader';
import {
  createResourceWriterDeps,
  type ResourceWriteResult,
  requireWritableLocation,
  writeDirectoryResource,
  writeFileResource,
} from './resource-writer';
import type { PreparedPropagationFile, PreparedPropagationOperation } from './write-shapes';

export interface PropagationWriteEngineDeps {
  writeDirectory(input: {
    readonly locationId: LibraryLocationId;
    readonly slug: string;
    readonly sourceDir?: string;
    readonly files?: readonly PreparedPropagationFile[];
    readonly env: PathEnv;
    readonly backupId: string;
  }): Promise<ResourceWriteResult>;
  writeFile(input: {
    readonly locationId: LibraryLocationId;
    readonly slug: string;
    readonly contents: string | Uint8Array;
    readonly env: PathEnv;
    readonly backupId: string;
  }): Promise<ResourceWriteResult>;
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
}

export interface ExecutePropagationWritesParams {
  readonly backupRoot: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
  readonly pathEnv: PathEnv;
  readonly backupId?: string;
  readonly operations: readonly PreparedPropagationOperation[];
  /** Stamped into the manifest so a store can name the environment it serves. */
  readonly environmentId?: string;
  /**
   * Aborts between operations. The hub's RPC deadline sends a cancel that ends
   * up here; without it the hub reports a failure while this loop keeps writing
   * every remaining destination, and the backupId that is the only undo handle
   * is lost with the rejected response.
   */
  readonly signal?: AbortSignal;
}

export function createPropagationWriteEngineDeps(
  options: {
    readonly backupRoot: string | (() => string);
    readonly retentionCount?: number | (() => number);
    readonly retentionBytes?: number | (() => number);
  },
  overrides: Partial<PropagationWriteEngineDeps> = {}
): PropagationWriteEngineDeps {
  const writer = createResourceWriterDeps(options);
  const backup = createBackupStoreDeps(options);
  return {
    writeDirectory: overrides.writeDirectory ?? ((input) => writeDirectoryResource(input, writer)),
    writeFile: overrides.writeFile ?? ((input) => writeFileResource(input, writer)),
    hashAt: overrides.hashAt ?? hashResourceAt,
    backup: overrides.backup ?? backup,
  };
}

export async function executePropagationWrites(
  params: ExecutePropagationWritesParams,
  deps: PropagationWriteEngineDeps = createPropagationWriteEngineDeps({
    backupRoot: params.backupRoot,
    retentionCount: params.retentionCount,
    retentionBytes: params.retentionBytes,
  })
): Promise<PropagationApply> {
  const env = params.pathEnv;
  // Echoed onto every row rather than resolved here: the id is the hub's name
  // for this connection, and a machine reachable from two hubs would answer with
  // two different ones. Absent means Local — every write before machines were
  // selectable was Local's.
  const environmentId = params.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const backupId = params.backupId ?? createBackupId(deps.backup);
  const written: BackupEntry[] = [];
  const applied: PropagationApplied[] = [];
  const failed: PropagationFailure[] = [];

  for (const operation of params.operations) {
    try {
      assertNotCancelled(params.signal);
      const result = await executeOperation(operation, env, backupId, environmentId, deps);
      written.push(result.entry);
      applied.push(result.applied);
    } catch (error) {
      failed.push(describeFailure(operation, environmentId, error));
      break;
    }
  }

  if (failed.length > 0) {
    const rolledBack = await rollback(written, deps);
    if (rolledBack) {
      await discardBackupSet(backupId, deps.backup).catch(() => undefined);
      return { partial: false, applied: [], skipped: [], failed, backups: [] };
    }
    await persistBackupManifest(backupId, written, params.environmentId, deps);
    return {
      partial: true,
      applied,
      skipped: [],
      failed,
      backupId,
      backups: [{ environmentId, backupId }],
    };
  }

  if (written.length === 0) {
    return { partial: false, applied, skipped: [], failed, backups: [] };
  }

  // Same contract as `executeRemovalWrites`: a successful write with no
  // recorded manifest leaves the user unable to undo, so roll back when we can
  // and otherwise return a partial result that still names the backup set.
  try {
    await persistBackupManifest(backupId, written, params.environmentId, deps);
  } catch (error) {
    const rolledBack = await rollback(written, deps);
    if (rolledBack) {
      await discardBackupSet(backupId, deps.backup).catch(() => undefined);
      return { partial: false, applied: [], skipped: [], failed, backups: [] };
    }
    failed.push({
      resourceKey: params.operations[0]?.resourceKey ?? '',
      environmentId,
      locationId: params.operations[0]?.locationId ?? '',
      reason: 'write-failed',
      message: `Could not record the backup manifest, so this apply cannot be undone automatically; the previous copies are under backup set "${backupId}": ${error instanceof Error ? error.message : String(error)}`,
    });
    return {
      partial: true,
      applied,
      skipped: [],
      failed,
      backupId,
      backups: [{ environmentId, backupId }],
    };
  }

  return {
    backupId,
    backups: [{ environmentId, backupId }],
    partial: false,
    applied,
    skipped: [],
    failed,
  };
}

async function persistBackupManifest(
  backupId: string,
  written: readonly BackupEntry[],
  environmentId: string | undefined,
  deps: PropagationWriteEngineDeps
): Promise<void> {
  await writeBackupManifest(
    {
      version: 3,
      backupId,
      createdAtMs: deps.backup.now().getTime(),
      entries: [...written],
      operation: 'propagation',
      ...(environmentId !== undefined && { environmentId }),
    },
    deps.backup
  );
  await pruneBackupSets(backupId, deps.backup);
}

async function executeOperation(
  operation: PreparedPropagationOperation,
  env: PathEnv,
  backupId: string,
  environmentId: string,
  deps: PropagationWriteEngineDeps
): Promise<{ entry: BackupEntry; applied: PropagationApplied }> {
  assertPreviewedRoot(operation, env);
  const result = await performWrite(operation, env, backupId, deps);
  try {
    const writtenContentHash = await hashWrittenContent(result, operation, deps);
    return {
      entry: backupEntryFrom(operation, result, writtenContentHash),
      applied: {
        resourceKey: operation.resourceKey,
        environmentId,
        locationId: operation.locationId,
        operation: operation.operation,
        destinationPath: result.destinationPath,
        contentHash: writtenContentHash,
        ...(operation.adaptation && {
          adaptation: {
            strategy: operation.adaptation.strategy,
            lossy: operation.adaptation.lossy,
            requiresReview: operation.adaptation.requiresReview,
            notes: [...operation.adaptation.notes],
            ...(operation.adaptation.provenance && {
              provenance: operation.adaptation.provenance,
            }),
          },
        }),
      },
    };
  } catch (error) {
    // The bytes are already on disk. Without this, a verification miss leaves
    // the write in place because the outer loop only rolls back operations that
    // returned an entry.
    await rollback([backupEntryFrom(operation, result, '')], deps);
    throw error;
  }
}

async function hashWrittenContent(
  result: ResourceWriteResult,
  operation: PreparedPropagationOperation,
  deps: PropagationWriteEngineDeps
): Promise<string> {
  let writtenContentHash: string;
  try {
    writtenContentHash = await deps.hashAt(result.resolvedDestinationPath, operation.kind);
  } catch (error) {
    if (error instanceof LibraryHashInvalidError) {
      throw new VerificationError(
        `Wrote "${result.destinationPath}" but hashing it failed (${error.invalidReason}).`
      );
    }
    throw error;
  }
  if (writtenContentHash !== operation.expectedContentHash) {
    throw new VerificationError(
      `Wrote "${result.destinationPath}" but its content hashed to ${writtenContentHash}, not ${operation.expectedContentHash}.`
    );
  }
  return writtenContentHash;
}

function backupEntryFrom(
  operation: PreparedPropagationOperation,
  result: ResourceWriteResult,
  writtenContentHash: string
): BackupEntry {
  return {
    locationId: operation.locationId,
    slug: operation.slug,
    kind: operation.kind,
    destinationPath: result.destinationPath,
    resolvedPath: result.resolvedDestinationPath,
    writtenContentHash,
    resourceKey: operation.resourceKey,
    ...(result.backupPath && { backupPath: result.backupPath }),
  };
}

function performWrite(
  operation: PreparedPropagationOperation,
  env: PathEnv,
  backupId: string,
  deps: PropagationWriteEngineDeps
): Promise<ResourceWriteResult> {
  if (operation.kind === 'directory') {
    // One or the other: a same-machine apply names a path here, a transferred
    // one carries the bytes. Neither means the hub prepared an operation that
    // cannot describe what to write.
    if (operation.sourceDir === undefined && operation.files === undefined) {
      throw new VerificationError(
        `"${operation.resourceKey}" is a directory write without a source directory or its files.`
      );
    }
    return deps.writeDirectory({
      locationId: operation.locationId,
      slug: operation.slug,
      ...(operation.sourceDir !== undefined && { sourceDir: operation.sourceDir }),
      ...(operation.files !== undefined && { files: operation.files }),
      env,
      backupId,
    });
  }

  if (operation.contents === undefined) {
    throw new VerificationError(`"${operation.resourceKey}" is a file write without contents.`);
  }
  return deps.writeFile({
    locationId: operation.locationId,
    slug: operation.slug,
    contents: operation.contents,
    env,
    backupId,
  });
}

async function rollback(
  written: readonly BackupEntry[],
  deps: PropagationWriteEngineDeps
): Promise<boolean> {
  let complete = true;
  for (const entry of [...written].reverse()) {
    try {
      if (entry.backupPath) await restoreBackupEntry(entry, deps.backup);
      else await deps.backup.fs.remove(entry.resolvedPath);
    } catch (error) {
      complete = false;
      console.error(`[library] Could not roll back "${entry.destinationPath}":`, error);
    }
  }
  return complete;
}

/**
 * Refuses a write whose location does not resolve where the preview said.
 *
 * The counterpart of `remove-writes.ts:assertPreviewedPath`, and load-bearing
 * for the same reason: `destinationRoot` is where the review step told the user
 * these bytes were going, while the root actually written under is resolved
 * here, from this host's own `PathEnv`. Those two agree for the in-process
 * Local runtime and are allowed to disagree the moment they are different
 * machines — at which point writing anyway lands bytes in a place nobody
 * consented to, silently.
 *
 * The root is compared rather than the resource path because that is what the
 * preview carries: `PropagationDestination.path` is `location.resolvePath(env)`
 * for the layouts that hold many resources, and the resource path itself only
 * for `single-file`, where the two coincide.
 */
function assertPreviewedRoot(operation: PreparedPropagationOperation, env: PathEnv): void {
  const location = requireWritableLocation(
    operation.locationId,
    operation.kind === 'directory' ? 'directory-of-dirs' : 'file'
  );
  const root = location.resolvePath(env);
  if (root !== null && resolvePath(root) === resolvePath(operation.destinationRoot)) return;
  throw new GuardError(
    `"${location.id}" resolves to "${root ?? 'nothing'}" on this machine, not the previewed "${operation.destinationRoot}".`
  );
}

class VerificationError extends Error {}
class GuardError extends Error {}

function describeFailure(
  operation: PreparedPropagationOperation,
  environmentId: string,
  error: unknown
): PropagationFailure {
  const reason =
    error instanceof VerificationError
      ? 'verification-failed'
      : error instanceof GuardError
        ? 'guard-rejected'
        : error instanceof Error && error.name === 'LibraryWriteError'
          ? 'guard-rejected'
          : 'write-failed';
  return {
    resourceKey: operation.resourceKey,
    environmentId,
    locationId: operation.locationId,
    reason,
    message: error instanceof Error ? error.message : String(error),
  };
}
