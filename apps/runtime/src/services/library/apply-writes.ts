/**
 * Filesystem execution for a prepared propagation apply: write, verify, backup
 * manifest, and compensate on failure. Planning, tokens, and format adapters
 * stay on the hub; this module only mutates the host that holds the files.
 */

import type {
  AdapterStrategy,
  AdaptNote,
  AdaptProvenance,
  PropagationApplied,
  PropagationApply,
  PropagationFailure,
  PropagationSkipped,
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
import { hashResourceAt } from './instance-reader';
import {
  createResourceWriterDeps,
  type ResourceWriteResult,
  writeDirectoryResource,
  writeFileResource,
} from './resource-writer';

export interface PreparedPropagationAdaptation {
  readonly strategy: AdapterStrategy;
  readonly lossy: boolean;
  readonly requiresReview: boolean;
  readonly notes: readonly AdaptNote[];
  readonly provenance?: AdaptProvenance;
}

export interface PreparedPropagationOperation {
  readonly resourceKey: string;
  readonly locationId: string;
  readonly slug: string;
  readonly operation: Extract<
    PropagationApplied['operation'],
    'create' | 'overwrite' | 'adapt-create' | 'adapt-overwrite'
  >;
  readonly kind: 'file' | 'directory';
  readonly expectedContentHash: string;
  readonly destinationPath: string;
  readonly sourceDir?: string;
  readonly contents?: string | Uint8Array;
  readonly adaptation?: PreparedPropagationAdaptation;
}

export interface PropagationWriteEngineDeps {
  writeDirectory(input: {
    readonly locationId: string;
    readonly slug: string;
    readonly sourceDir: string;
    readonly env: PathEnv;
    readonly backupId: string;
  }): Promise<ResourceWriteResult>;
  writeFile(input: {
    readonly locationId: string;
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
  readonly skipped?: readonly PropagationSkipped[];
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
    writeDirectory:
      overrides.writeDirectory ??
      ((input) =>
        writeDirectoryResource({ ...input, locationId: input.locationId as never }, writer)),
    writeFile:
      overrides.writeFile ??
      ((input) => writeFileResource({ ...input, locationId: input.locationId as never }, writer)),
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
  const skipped = params.skipped ?? [];

  for (const operation of params.operations) {
    try {
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
      return { partial: false, applied: [], skipped: [...skipped], failed };
    }
    await persistBackupManifest(backupId, written, deps);
    return { partial: true, applied, skipped: [...skipped], failed, backupId };
  }

  if (written.length > 0) await persistBackupManifest(backupId, written, deps);

  if (written.length === 0) {
    return { partial: false, applied, skipped: [...skipped], failed };
  }
  return { backupId, partial: false, applied, skipped: [...skipped], failed };
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

class VerificationError extends Error {}

function describeFailure(
  operation: PreparedPropagationOperation,
  error: unknown
): PropagationFailure {
  const reason =
    error instanceof VerificationError
      ? 'verification-failed'
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
