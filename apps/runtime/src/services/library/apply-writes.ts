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
import { hashResourceAt } from './instance-reader';
import {
  createResourceWriterDeps,
  type ResourceWriteResult,
  requireWritableLocation,
  writeDirectoryResource,
  writeFileResource,
} from './resource-writer';
import type { PreparedPropagationOperation } from './write-shapes';

export interface PropagationWriteEngineDeps {
  writeDirectory(input: {
    readonly locationId: LibraryLocationId;
    readonly slug: string;
    readonly sourceDir: string;
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
  const backupId = params.backupId ?? createBackupId(deps.backup);
  const written: BackupEntry[] = [];
  const applied: PropagationApplied[] = [];
  const failed: PropagationFailure[] = [];

  for (const operation of params.operations) {
    try {
      assertNotCancelled(params.signal);
      const result = await executeOperation(operation, env, backupId, deps);
      written.push(result.entry);
      applied.push(result.applied);
    } catch (error) {
      failed.push(describeFailure(operation, error));
      break;
    }
  }

  if (failed.length > 0) {
    const rolledBack = await rollback(written, deps);
    if (rolledBack) {
      await discardBackupSet(backupId, deps.backup).catch(() => undefined);
      return { partial: false, applied: [], skipped: [], failed };
    }
    await persistBackupManifest(backupId, written, deps);
    return { partial: true, applied, skipped: [], failed, backupId };
  }

  if (written.length > 0) await persistBackupManifest(backupId, written, deps);

  if (written.length === 0) {
    return { partial: false, applied, skipped: [], failed };
  }
  return { backupId, partial: false, applied, skipped: [], failed };
}

async function persistBackupManifest(
  backupId: string,
  written: readonly BackupEntry[],
  deps: PropagationWriteEngineDeps
): Promise<void> {
  await writeBackupManifest(
    {
      version: 2,
      backupId,
      createdAtMs: deps.backup.now().getTime(),
      entries: [...written],
      operation: 'propagation',
    },
    deps.backup
  );
  await pruneBackupSets(backupId, deps.backup);
}

async function executeOperation(
  operation: PreparedPropagationOperation,
  env: PathEnv,
  backupId: string,
  deps: PropagationWriteEngineDeps
): Promise<{ entry: BackupEntry; applied: PropagationApplied }> {
  assertPreviewedRoot(operation, env);
  const result = await performWrite(operation, env, backupId, deps);
  const writtenContentHash = await deps.hashAt(result.resolvedDestinationPath, operation.kind);
  if (writtenContentHash !== operation.expectedContentHash) {
    throw new VerificationError(
      `Wrote "${result.destinationPath}" but its content hashed to ${writtenContentHash}, not ${operation.expectedContentHash}.`
    );
  }

  return {
    entry: {
      locationId: operation.locationId,
      slug: operation.slug,
      kind: operation.kind,
      destinationPath: result.destinationPath,
      resolvedPath: result.resolvedDestinationPath,
      writtenContentHash,
      resourceKey: operation.resourceKey,
      ...(result.backupPath && { backupPath: result.backupPath }),
    },
    applied: {
      resourceKey: operation.resourceKey,
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
}

function performWrite(
  operation: PreparedPropagationOperation,
  env: PathEnv,
  backupId: string,
  deps: PropagationWriteEngineDeps
): Promise<ResourceWriteResult> {
  if (operation.kind === 'directory') {
    if (operation.sourceDir === undefined) {
      throw new VerificationError(
        `"${operation.resourceKey}" is a directory write without a source directory.`
      );
    }
    return deps.writeDirectory({
      locationId: operation.locationId,
      slug: operation.slug,
      sourceDir: operation.sourceDir,
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
    locationId: operation.locationId,
    reason,
    message: error instanceof Error ? error.message : String(error),
  };
}
