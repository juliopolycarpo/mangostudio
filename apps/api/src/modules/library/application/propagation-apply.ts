/**
 * The write half of library propagation: verify the preview still describes
 * reality, plan every operation, write with a backup and a post-write hash
 * check, and roll the whole thing back if any single write fails.
 *
 * Every control here is load-bearing. The forced rescan behind the preview, the
 * state hash, the backup, the verification, and the undo route are collectively
 * what makes it reasonable to ask a user to let an app write into `~/.claude`.
 * None of them is optional, and none of them should be relaxed for speed.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  type AdapterStrategy,
  hashLibraryFile,
  type LibraryDivergenceAckRequest,
  type PropagationApplied,
  type PropagationApply,
  type PropagationApplyRequest,
  type PropagationBackupUsage,
  type PropagationDecision,
  type PropagationDestination,
  type PropagationFailure,
  type PropagationPreview,
  type PropagationPreviewEntry,
  type PropagationPreviewRequest,
  type PropagationSkipped,
  type PropagationSourceGroup,
  type PropagationUndo,
} from '@mangostudio/shared/library';
import { PropagationRequestError } from '../domain/propagation-error';
import { getLibraryLocation, type LocationDefinition, type PathEnv } from '../domain/registry';
import {
  type BackupEntry,
  type BackupStoreDeps,
  createBackupId,
  defaultBackupStoreDeps,
  discardBackupSet,
  measureBackupUsage,
  pruneBackupSets,
  readBackupManifest,
  restoreBackupEntry,
  writeBackupManifest,
} from '../infrastructure/backup-store';
import { hashResourceAt, readResourceFile } from '../infrastructure/instance-reader';
import { createLibraryPathEnv } from '../infrastructure/location-probe';
import {
  type ResourceWriteResult,
  writeDirectoryResource,
  writeFileResource,
} from '../infrastructure/resource-writer';
import { acknowledgeDivergence } from './conflict-resolution';
import { previewLibraryPropagation } from './propagation-preview';

export interface PropagationApplyDeps {
  preview(userId: string, request: PropagationPreviewRequest): Promise<PropagationPreview>;
  pathEnv(): PathEnv;
  readSourceFile(path: string): Promise<Uint8Array>;
  writeDirectory(input: DirectoryWrite): Promise<ResourceWriteResult>;
  writeFile(input: FileWrite): Promise<ResourceWriteResult>;
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  acknowledge(userId: string, request: LibraryDivergenceAckRequest): Promise<unknown>;
  backup: BackupStoreDeps;
}

interface DirectoryWrite {
  readonly locationId: string;
  readonly slug: string;
  readonly sourceDir: string;
  readonly env: PathEnv;
  readonly backupId: string;
}

interface FileWrite {
  readonly locationId: string;
  readonly slug: string;
  readonly contents: string;
  readonly env: PathEnv;
  readonly backupId: string;
}

function resolveDeps(overrides: Partial<PropagationApplyDeps>): PropagationApplyDeps {
  return {
    preview: overrides.preview ?? previewLibraryPropagation,
    pathEnv: overrides.pathEnv ?? (() => createLibraryPathEnv()),
    readSourceFile: overrides.readSourceFile ?? readResourceFile,
    writeDirectory:
      overrides.writeDirectory ??
      ((input) => writeDirectoryResource({ ...input, locationId: input.locationId })),
    writeFile:
      overrides.writeFile ??
      ((input) => writeFileResource({ ...input, locationId: input.locationId })),
    hashAt: overrides.hashAt ?? hashResourceAt,
    acknowledge: overrides.acknowledge ?? acknowledgeDivergence,
    backup: overrides.backup ?? defaultBackupStoreDeps,
  };
}

/**
 * Applies run one at a time. Two browser tabs applying at once would otherwise
 * interleave backups and swaps; serialized, the second waits and then fails its
 * own state-hash check, which is exactly the outcome the user should get.
 */
let applyQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = applyQueue.then(task, task);
  applyQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function applyLibraryPropagation(
  userId: string,
  request: PropagationApplyRequest,
  overrides: Partial<PropagationApplyDeps> = {}
): Promise<PropagationApply> {
  return serialized(() => runApply(userId, request, resolveDeps(overrides)));
}

async function runApply(
  userId: string,
  request: PropagationApplyRequest,
  deps: PropagationApplyDeps
): Promise<PropagationApply> {
  const preview = await deps.preview(userId, request.request);
  // Both must match: the token pins which preview this answers, the state hash
  // pins the bytes it described. A file edited in another window between the
  // two calls fails here instead of being silently overwritten.
  if (
    !constantTimeEquals(preview.previewToken, request.previewToken) ||
    !constantTimeEquals(preview.stateHash, request.stateHash)
  ) {
    throw new PropagationRequestError(
      409,
      'The library changed since this preview was taken. Preview again before applying.'
    );
  }

  const plan = planApply(preview, request.decisions);
  const env = deps.pathEnv();
  const backupId = createBackupId(deps.backup);
  const written: BackupEntry[] = [];
  const applied: PropagationApplied[] = [];
  const failed: PropagationFailure[] = [];

  for (const operation of plan.operations) {
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
    // The backup set is the only recovery path when a compensation fails, so it
    // is discarded only once the filesystem is provably back where it started.
    if (rolledBack) await discardBackupSet(backupId, deps.backup).catch(() => undefined);
    return {
      partial: !rolledBack,
      applied: [],
      skipped: plan.skipped,
      failed,
      ...(rolledBack ? {} : { backupId }),
    };
  }

  for (const acknowledgement of plan.acknowledgements) {
    await deps.acknowledge(userId, acknowledgement);
  }

  if (written.length === 0) {
    return { partial: false, applied, skipped: plan.skipped, failed };
  }

  await writeBackupManifest(
    { version: 1, backupId, createdAtMs: deps.backup.now().getTime(), entries: written },
    deps.backup
  );
  await pruneBackupSets(backupId, deps.backup);
  return { backupId, partial: false, applied, skipped: plan.skipped, failed };
}

interface PlannedOperation {
  readonly resourceKey: string;
  readonly locationId: string;
  readonly slug: string;
  readonly operation: PropagationApplied['operation'];
  readonly kind: 'file' | 'directory';
  readonly sourcePath: string;
  readonly editedContent?: string;
  readonly expectedContentHash: string;
  readonly destinationPath: string;
}

interface ApplyPlan {
  readonly operations: PlannedOperation[];
  readonly skipped: PropagationSkipped[];
  readonly acknowledgements: LibraryDivergenceAckRequest[];
}

/**
 * Turns reviewed decisions into an ordered write list, rejecting anything the
 * preview did not offer. Ordering is deterministic so a failure mid-apply
 * always compensates the same set, and so two identical applies do the same
 * thing in the same order.
 */
function planApply(
  preview: PropagationPreview,
  decisions: readonly PropagationDecision[]
): ApplyPlan {
  const byKey = new Map<string, PropagationDecision>();
  for (const decision of decisions) {
    if (byKey.has(decision.resourceKey)) {
      throw validationError(`Duplicate decision for "${decision.resourceKey}".`);
    }
    byKey.set(decision.resourceKey, decision);
  }
  if (byKey.size !== preview.entries.length) {
    throw validationError('Apply must include exactly one decision for every preview entry.');
  }

  const operations: PlannedOperation[] = [];
  const skipped: PropagationSkipped[] = [];
  const acknowledgements: LibraryDivergenceAckRequest[] = [];

  for (const entry of [...preview.entries].sort((left, right) =>
    compareText(left.resourceKey, right.resourceKey)
  )) {
    const decision = byKey.get(entry.resourceKey);
    if (!decision) {
      throw validationError(`Apply is missing a decision for "${entry.resourceKey}".`);
    }

    if (decision.resolution === 'keep-per-location') {
      acknowledgements.push(planAcknowledgement(entry, decision));
      skipped.push({ resourceKey: entry.resourceKey, reason: 'divergence-acknowledged' });
      continue;
    }

    const winner = resolveWinner(entry, decision);
    for (const target of decision.destinations) {
      const destination = entry.destinations.find(
        (candidate) => candidate.locationId === target.locationId
      );
      if (!destination) {
        throw validationError(
          `Destination "${target.locationId}" was not offered for "${entry.resourceKey}".`
        );
      }
      if (target.action === 'skip') {
        skipped.push({
          resourceKey: entry.resourceKey,
          locationId: target.locationId,
          reason: 'user-skipped',
        });
        continue;
      }
      const planned = planDestination(entry, decision, winner, destination, target.strategy);
      if (planned === null) {
        skipped.push({
          resourceKey: entry.resourceKey,
          locationId: target.locationId,
          reason: 'already-in-sync',
        });
        continue;
      }
      operations.push(planned);
    }
  }

  operations.sort(
    (left, right) =>
      compareText(left.resourceKey, right.resourceKey) ||
      compareText(left.locationId, right.locationId)
  );
  return { operations, skipped, acknowledgements };
}

function planAcknowledgement(
  entry: PropagationPreviewEntry,
  decision: PropagationDecision
): LibraryDivergenceAckRequest {
  if (entry.sourceGroups.length < 2) {
    throw validationError(
      `"${entry.resourceKey}" is not divergent, so there is no divergence to keep.`
    );
  }
  if (decision.destinations.some((target) => target.action === 'apply')) {
    throw validationError(
      `"${entry.resourceKey}" cannot both keep its divergence and write to a destination.`
    );
  }
  return {
    resourceKey: entry.resourceKey,
    contentHashes: entry.sourceGroups.map((group) => group.contentHash),
  };
}

interface ResolvedWinner {
  readonly contentHash: string;
  readonly sourcePath: string;
  readonly editedContent?: string;
}

/**
 * The bytes that win. There is no default: a resource with more than one
 * readable version must be settled by an explicit choice, because the system
 * has no basis for making it and guessing is how a user loses the version they
 * actually wanted.
 */
function resolveWinner(
  entry: PropagationPreviewEntry,
  decision: PropagationDecision
): ResolvedWinner {
  if (decision.resolution === 'edit-then-adopt') {
    if (decision.editedContent === undefined) {
      throw validationError(`"${entry.resourceKey}" needs edited content to adopt.`);
    }
    if (decision.winnerContentHash !== undefined) {
      throw validationError(
        `"${entry.resourceKey}" cannot name a winning version and supply edited content.`
      );
    }
    if (entry.ref.kind === 'skill') {
      throw validationError(
        `"${entry.resourceKey}" is a directory resource and cannot be adopted from edited text.`
      );
    }
    return { contentHash: '', sourcePath: '', editedContent: decision.editedContent };
  }

  if (decision.editedContent !== undefined) {
    throw validationError(
      `"${entry.resourceKey}" supplied edited content without choosing edit-then-adopt.`
    );
  }
  if (entry.sourceGroups.length === 0) {
    throw validationError(`"${entry.resourceKey}" has no readable version to propagate.`);
  }
  if (decision.winnerContentHash === undefined) {
    if (entry.requiresWinnerSelection) {
      throw validationError(
        `"${entry.resourceKey}" has more than one version; the apply must name the winner.`
      );
    }
    return toWinner(entry.sourceGroups[0]);
  }

  const group = entry.sourceGroups.find(
    (candidate) => candidate.contentHash === decision.winnerContentHash
  );
  if (!group) {
    throw validationError(
      `Winner "${decision.winnerContentHash}" is not a version of "${entry.resourceKey}".`
    );
  }
  return toWinner(group);
}

function toWinner(group: PropagationSourceGroup): ResolvedWinner {
  return { contentHash: group.contentHash, sourcePath: group.contentPath };
}

/** Returns null when the destination already holds the winner and needs no write. */
function planDestination(
  entry: PropagationPreviewEntry,
  decision: PropagationDecision,
  winner: ResolvedWinner,
  destination: PropagationDestination,
  strategy: AdapterStrategy | undefined
): PlannedOperation | null {
  if (destination.blockedReason) {
    throw validationError(
      `Destination "${destination.locationId}" for "${entry.resourceKey}" is blocked (${destination.blockedReason}).`
    );
  }

  const location = getLibraryLocation(destination.locationId);
  if (!location) {
    throw validationError(`Unknown library location: "${destination.locationId}".`);
  }

  if (decision.resolution === 'edit-then-adopt') {
    return {
      resourceKey: entry.resourceKey,
      locationId: destination.locationId,
      slug: entry.ref.slug,
      operation: destination.currentContentHash === undefined ? 'create' : 'overwrite',
      kind: 'file',
      sourcePath: '',
      editedContent: winner.editedContent,
      expectedContentHash: '',
      destinationPath: destination.path ?? '',
    };
  }

  const outcome = destination.outcomes.find(
    (candidate) => candidate.winnerContentHash === winner.contentHash
  );
  if (!outcome) {
    throw validationError(
      `The preview has no outcome for "${entry.resourceKey}" at "${destination.locationId}".`
    );
  }
  if (outcome.operation === 'blocked') {
    throw validationError(
      `Writing "${entry.resourceKey}" to "${destination.locationId}" is blocked (${outcome.blockedReason}).`
    );
  }
  if (strategy !== undefined && !outcome.adaptation?.availableStrategies.includes(strategy)) {
    throw validationError(
      `Strategy "${strategy}" is not offered for "${entry.resourceKey}" at "${destination.locationId}".`
    );
  }
  if (outcome.operation === 'noop') return null;

  return {
    resourceKey: entry.resourceKey,
    locationId: destination.locationId,
    slug: entry.ref.slug,
    operation: outcome.operation,
    kind: writeKindFor(location),
    sourcePath: winner.sourcePath,
    expectedContentHash: winner.contentHash,
    destinationPath: destination.path ?? '',
  };
}

function writeKindFor(location: LocationDefinition): 'file' | 'directory' {
  return location.layout === 'directory-of-dirs' ? 'directory' : 'file';
}

async function executeOperation(
  operation: PlannedOperation,
  env: PathEnv,
  backupId: string,
  deps: PropagationApplyDeps
): Promise<{ entry: BackupEntry; applied: PropagationApplied }> {
  const { result, expectedContentHash } = await performWrite(operation, env, backupId, deps);

  // Re-hash what is actually on disk. A truncated write or a bad adapter output
  // has to be caught here, not by the user noticing something broken later.
  const writtenContentHash = await deps.hashAt(result.resolvedDestinationPath, operation.kind);
  if (writtenContentHash !== expectedContentHash) {
    throw new VerificationError(
      `Wrote "${result.destinationPath}" but its content hashed to ${writtenContentHash}, not ${expectedContentHash}.`
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
      ...(result.backupPath && { backupPath: result.backupPath }),
    },
    applied: {
      resourceKey: operation.resourceKey,
      locationId: operation.locationId,
      operation: operation.operation,
      destinationPath: result.destinationPath,
      contentHash: writtenContentHash,
    },
  };
}

async function performWrite(
  operation: PlannedOperation,
  env: PathEnv,
  backupId: string,
  deps: PropagationApplyDeps
): Promise<{ result: ResourceWriteResult; expectedContentHash: string }> {
  if (operation.kind === 'directory') {
    const result = await deps.writeDirectory({
      locationId: operation.locationId,
      slug: operation.slug,
      sourceDir: operation.sourcePath,
      env,
      backupId,
    });
    return { result, expectedContentHash: operation.expectedContentHash };
  }

  const bytes =
    operation.editedContent === undefined
      ? await deps.readSourceFile(operation.sourcePath)
      : new TextEncoder().encode(operation.editedContent);
  // Edited bytes exist in no location yet, so their expected hash is computed
  // here rather than taken from a preview group.
  const expectedContentHash =
    operation.editedContent === undefined
      ? operation.expectedContentHash
      : (await hashLibraryFile(operation.destinationPath, { readFile: () => bytes })).contentHash;

  const result = await deps.writeFile({
    locationId: operation.locationId,
    slug: operation.slug,
    contents: new TextDecoder().decode(bytes),
    env,
    backupId,
  });
  return { result, expectedContentHash };
}

/**
 * Undoes the writes recorded so far, newest first. Returns false when any
 * compensation failed, which is the one case where the caller must not discard
 * the backups and must report the apply as partial.
 */
async function rollback(
  written: readonly BackupEntry[],
  deps: PropagationApplyDeps
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

/** Retained backup count and size, plus the bounds they are trimmed to. */
export async function describeBackupUsage(
  deps: BackupStoreDeps = defaultBackupStoreDeps
): Promise<PropagationBackupUsage> {
  const usage = await measureBackupUsage(deps);
  return {
    ...usage,
    retentionCount: deps.retentionCount(),
    retentionBytes: deps.retentionBytes(),
  };
}

export interface PropagationUndoDeps {
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
}

/**
 * Restores every path an apply backed up and removes every path it created.
 *
 * A destination that changed after the apply is left alone rather than
 * reverted: undoing an apply must not also discard an edit the user made
 * afterwards, and silently doing so would be the same class of mistake the
 * state hash exists to prevent.
 */
export function undoLibraryPropagation(
  backupId: string,
  overrides: Partial<PropagationUndoDeps> = {}
): Promise<PropagationUndo> {
  const deps: PropagationUndoDeps = {
    hashAt: overrides.hashAt ?? hashResourceAt,
    backup: overrides.backup ?? defaultBackupStoreDeps,
  };
  return serialized(() => runUndo(backupId, deps));
}

async function runUndo(backupId: string, deps: PropagationUndoDeps): Promise<PropagationUndo> {
  const manifest = await readBackupManifest(backupId, deps.backup).catch(() => null);
  if (!manifest) {
    throw new PropagationRequestError(
      404,
      `No library backup "${backupId}" is retained. Backups are bounded by count and size.`
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

  return { backupId, restored, removed, skipped };
}

class VerificationError extends Error {}

function describeFailure(operation: PlannedOperation, error: unknown): PropagationFailure {
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

function validationError(message: string): PropagationRequestError {
  return new PropagationRequestError(422, message);
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
