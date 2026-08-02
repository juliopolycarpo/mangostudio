/**
 * The write half of library removal: verify the preview still describes
 * reality, verify the user acknowledged anything they are about to lose the
 * last copy of, back each instance up in full, move it aside, prove it is gone,
 * and put everything back if any single step fails.
 *
 * This deletes user files. Every control propagation has applies here, plus two
 * of its own — the last-copy acknowledgement and the pinned backup — and none
 * of them is deferrable to a follow-up. A removal feature whose undo is
 * best-effort is worse than no removal feature.
 */

import { resolve as resolvePath } from 'node:path';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  RemovalApply,
  RemovalApplyRequest,
  RemovalFailure,
  RemovalKept,
  RemovalPreview,
  RemovalPreviewEntry,
  RemovalPreviewRequest,
  RemovalRemoved,
} from '@mangostudio/shared/library';
import { getLibraryLocation, type LocationDefinition } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { assertRequestedProfileId, ProfileMismatchError } from '../../../lib/profile-context';
import { constantTimeEquals } from '../../../utils/hash';
import { LibraryRequestError } from '../domain/library-request-error';
import { assertExpectedResourceEntry } from '../domain/path-safety';
import {
  type BackupEntry,
  type BackupStoreDeps,
  backupExistingResource,
  createBackupId,
  defaultBackupStoreDeps,
  discardBackupSet,
  pruneBackupSets,
  writeBackupManifest,
} from '../infrastructure/backup-store';
import { hashResourceAt } from '../infrastructure/instance-reader';
import { createLibraryPathEnv } from '../infrastructure/location-probe';
import {
  requireWritableLocation,
  resolveResourceDestination,
} from '../infrastructure/resource-writer';
import {
  nodeTreeRemovalFs,
  type StagedRemoval,
  stageResourceRemoval,
  type TreeRemovalFs,
} from '../infrastructure/tree-removal';
import { serializeLibraryWrite } from './apply-queue';
import { compareText } from './preview-state';
import { previewLibraryRemoval } from './removal-preview';

export interface RemovalApplyDeps {
  preview(userId: string, request: RemovalPreviewRequest): Promise<RemovalPreview>;
  pathEnv(): PathEnv;
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
  treeFs: TreeRemovalFs;
}

function resolveDeps(overrides: Partial<RemovalApplyDeps>): RemovalApplyDeps {
  return {
    preview: overrides.preview ?? previewLibraryRemoval,
    pathEnv: overrides.pathEnv ?? (() => createLibraryPathEnv()),
    hashAt: overrides.hashAt ?? hashResourceAt,
    backup: overrides.backup ?? defaultBackupStoreDeps,
    treeFs: overrides.treeFs ?? nodeTreeRemovalFs,
  };
}

export function applyLibraryRemoval(
  userId: string,
  request: RemovalApplyRequest,
  overrides: Partial<RemovalApplyDeps> = {}
): Promise<RemovalApply> {
  return serializeLibraryWrite(() => runRemoval(userId, request, resolveDeps(overrides)));
}

async function runRemoval(
  userId: string,
  request: RemovalApplyRequest,
  deps: RemovalApplyDeps
): Promise<RemovalApply> {
  try {
    assertRequestedProfileId(request.profileId, { userId });
  } catch (error) {
    if (error instanceof ProfileMismatchError) {
      throw new LibraryRequestError(400, error.message);
    }
    throw error;
  }

  const preview = await deps.preview(userId, request.request);
  // The state hash matters more here than it does in propagation. Between
  // preview and apply the user may have edited the very copy they are about to
  // delete, and this rejection is the only thing standing between that edit and
  // its disappearance.
  if (
    !constantTimeEquals(preview.previewToken, request.previewToken) ||
    !constantTimeEquals(preview.stateHash, request.stateHash)
  ) {
    throw new LibraryRequestError(
      409,
      'The library changed since this preview was taken. Preview again before removing.'
    );
  }

  const plan = planRemoval(preview, request);
  const env = deps.pathEnv();
  const backupId = createBackupId(deps.backup);
  const results: StagedOperation[] = [];
  const failed: RemovalFailure[] = [];

  for (const operation of plan.operations) {
    try {
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
    // Captured before the rollback, because it is the staging loop that stopped
    // short: everything after the failing operation was never tried, and the
    // user reviewed those locations too.
    const unattempted = notAttempted(plan.operations, results.length);
    const unrestored = await rollback(staged);
    const kept = [...plan.kept, ...rolledBack(results, unrestored), ...unattempted];
    if (unrestored.size === 0) {
      // Every tree is back where it started, so the copies in the backup set
      // are redundant and keeping them would only confuse the retention budget.
      await discardBackupSet(backupId, deps.backup).catch(() => undefined);
      return { partial: false, removed: [], kept, failed };
    }
    // Compensation failed for some copies. Only those are reported as removed:
    // a tree the rollback did put back is on disk, and listing it here would
    // send the caller to restore a path that never went anywhere. The manifest
    // still carries every entry, so `undo` can reach all of them.
    await persistManifest(backupId, entries, plan, deps);
    return {
      partial: true,
      removed: stillRemoved(results, unrestored),
      kept,
      failed,
      backupId,
    };
  }

  if (entries.length === 0) {
    return { partial: false, removed, kept: plan.kept, failed };
  }

  // The manifest lands before the staged trees are deleted, never after. Until
  // it exists there is no handle `undo` can take, and the staged tree is the
  // last in-place copy — destroying it first would turn a crash in between into
  // an unrecoverable removal.
  try {
    await persistManifest(backupId, entries, plan, deps);
  } catch (error) {
    const unrestored = await rollback(staged);
    if (unrestored.size === 0) await discardBackupSet(backupId, deps.backup).catch(() => undefined);
    failed.push({
      resourceKey: plan.operations[0]?.resourceKey ?? '',
      locationId: plan.operations[0]?.locationId ?? '',
      reason: 'remove-failed',
      // The set id belongs in the message rather than in `backupId`: without a
      // manifest `undo` resolves nothing and answers 404, so returning the field
      // would render a restore button that cannot work. Naming the set here
      // still points a human at the copies, which is all that is left.
      message: `Could not record the backup manifest, so this removal cannot be undone automatically; the copies are under backup set "${backupId}": ${errorMessage(error)}`,
    });
    const kept = [...plan.kept, ...rolledBack(results, unrestored)];
    return unrestored.size === 0
      ? { partial: false, removed: [], kept, failed }
      : {
          partial: true,
          removed: stillRemoved(results, unrestored),
          kept,
          failed,
        };
  }

  for (const stage of staged) {
    // A staged tree that cannot be deleted is a stale sibling the next preview
    // and `mango doctor` both report. It is never a reason to fail an apply
    // whose destinations are already provably gone.
    await stage.commit().catch((error: unknown) => {
      console.error(`[library] Could not clean up "${stage.stagePath}":`, error);
    });
  }
  await pruneBackupSets(backupId, deps.backup);

  return { backupId, partial: false, removed, kept: plan.kept, failed };
}

async function persistManifest(
  backupId: string,
  entries: readonly BackupEntry[],
  plan: RemovalPlan,
  deps: RemovalApplyDeps
): Promise<void> {
  await writeBackupManifest(
    {
      version: 2,
      backupId,
      createdAtMs: deps.backup.now().getTime(),
      entries: [...entries],
      // Every entry here carries a backup, so undoing this set only ever puts
      // content back. Recording that is what lets a listed row say "put the
      // removed copies back" instead of the neutral verb a propagation set has
      // to use, where undo can also delete.
      operation: 'removal',
      // Pinning is decided by what the apply actually did, not by what the
      // preview offered: a set holding someone's only copy of a skill must
      // never be evicted to reclaim disk.
      ...(plan.lastCopyResourceKeys.length > 0 && {
        pinned: true,
        lastCopyResourceKeys: [...plan.lastCopyResourceKeys],
      }),
    },
    deps.backup
  );
}

interface PlannedRemoval {
  readonly resourceKey: string;
  readonly locationId: string;
  readonly slug: string;
  readonly kind: 'file' | 'directory';
  readonly expectedPath: string;
  readonly expectedContentHash: string;
  readonly lastCopy: boolean;
}

interface RemovalPlan {
  readonly operations: PlannedRemoval[];
  readonly kept: RemovalKept[];
  readonly lastCopyResourceKeys: string[];
}

/**
 * Turns reviewed decisions into an ordered removal list, rejecting anything the
 * preview did not offer. Ordering is deterministic so a failure mid-apply
 * always compensates the same set.
 */
function planRemoval(preview: RemovalPreview, request: RemovalApplyRequest): RemovalPlan {
  const byKey = new Map<string, RemovalApplyRequest['decisions'][number]>();
  for (const decision of request.decisions) {
    if (byKey.has(decision.resourceKey)) {
      throw validationError(`Duplicate decision for "${decision.resourceKey}".`);
    }
    byKey.set(decision.resourceKey, decision);
  }
  if (byKey.size !== preview.entries.length) {
    throw validationError('Apply must include exactly one decision for every preview entry.');
  }

  const previewKeys = new Set(preview.entries.map((entry) => entry.resourceKey));
  const acknowledged = new Set<string>();
  for (const key of request.acknowledgeLastCopy) {
    // An acknowledgement for a resource this apply is not touching is a client
    // whose model of the request differs from the server's. Accepting it would
    // mean accepting a sign-off aimed at something else.
    if (!previewKeys.has(key)) {
      throw validationError(`"${key}" is not part of this removal, so it cannot be acknowledged.`);
    }
    acknowledged.add(key);
  }

  const operations: PlannedRemoval[] = [];
  const kept: RemovalKept[] = [];
  const lastCopyResourceKeys: string[] = [];

  for (const entry of [...preview.entries].sort((left, right) =>
    compareText(left.resourceKey, right.resourceKey)
  )) {
    const decision = byKey.get(entry.resourceKey);
    if (!decision) {
      throw validationError(`Apply is missing a decision for "${entry.resourceKey}".`);
    }

    const decided = new Map<string, 'remove' | 'keep'>();
    for (const target of decision.locations) {
      if (decided.has(target.locationId)) {
        throw validationError(
          `Duplicate decision for location "${target.locationId}" of "${entry.resourceKey}".`
        );
      }
      decided.set(target.locationId, target.action);
    }
    // The same rule propagation applies to destinations: every location the
    // preview showed comes back explicitly removed or kept, so the response can
    // never be silent about somewhere the user was shown.
    const missing = entry.locations
      .filter((location) => !decided.has(location.locationId))
      .map((location) => `"${location.locationId}"`);
    if (missing.length > 0) {
      throw validationError(
        `Apply must decide every location the preview offered for "${entry.resourceKey}"; missing ${missing.join(', ')}.`
      );
    }
    for (const locationId of decided.keys()) {
      if (!entry.locations.some((location) => location.locationId === locationId)) {
        throw validationError(
          `Location "${locationId}" was not offered for "${entry.resourceKey}".`
        );
      }
    }

    const removing = new Set<string>();
    for (const location of entry.locations) {
      const action = decided.get(location.locationId);
      if (action !== 'remove') {
        kept.push({
          resourceKey: entry.resourceKey,
          locationId: location.locationId,
          reason: location.operation === 'remove' ? 'user-kept' : location.operation,
        });
        continue;
      }
      if (location.operation !== 'remove') {
        throw validationError(
          `"${entry.resourceKey}" cannot be removed from "${location.locationId}" (${location.blockedReason ?? location.operation}).`
        );
      }
      if (location.path === null || location.contentHash === undefined) {
        throw validationError(
          `The preview has no readable copy of "${entry.resourceKey}" at "${location.locationId}".`
        );
      }
      const definition = getLibraryLocation(location.locationId);
      if (!definition) {
        throw validationError(`Unknown library location: "${location.locationId}".`);
      }
      removing.add(location.locationId);
      operations.push({
        resourceKey: entry.resourceKey,
        locationId: location.locationId,
        slug: entry.ref.slug,
        // Layout, not kind: what is on disk at a destination is decided by the
        // location that holds it, and a skill is a tree only where the registry
        // says that location stores trees.
        kind: definition.layout === 'directory-of-dirs' ? 'directory' : 'file',
        expectedPath: location.path,
        expectedContentHash: location.contentHash,
        lastCopy: false,
      });
    }

    if (removing.size === 0) continue;
    const zeroesResource = entry.instanceLocationIds.every((locationId) =>
      removing.has(locationId)
    );
    if (!zeroesResource) continue;

    if (!acknowledged.has(entry.resourceKey)) {
      throw new LibraryRequestError(
        422,
        `Removing "${entry.resourceKey}" from every location would leave no copy anywhere. Acknowledge it explicitly to proceed.`,
        ERROR_CODES.LAST_COPY_UNACKNOWLEDGED
      );
    }
    lastCopyResourceKeys.push(entry.resourceKey);
    markLastCopy(operations, entry);
  }

  operations.sort(
    (left, right) =>
      compareText(left.resourceKey, right.resourceKey) ||
      compareText(left.locationId, right.locationId)
  );
  return { operations, kept, lastCopyResourceKeys };
}

/** Flags this entry's planned removals so the response can say which copy was the last. */
function markLastCopy(operations: PlannedRemoval[], entry: RemovalPreviewEntry): void {
  for (const [index, operation] of operations.entries()) {
    if (operation.resourceKey !== entry.resourceKey) continue;
    operations[index] = { ...operation, lastCopy: true };
  }
}

interface StagedOperation {
  readonly staged: StagedRemoval;
  readonly entry: BackupEntry;
  readonly removed: RemovalRemoved;
}

/**
 * Backs one instance up and moves it aside, leaving nothing deleted yet.
 *
 * Every guard the writer applies runs first — registry access, layout, the
 * containment check behind `resolveResourceDestination`, and the entry-type
 * check that refuses to unlink a device or a socket — and the content is
 * re-hashed from disk rather than trusted from the preview.
 */
async function stageOperation(
  operation: PlannedRemoval,
  env: PathEnv,
  backupId: string,
  deps: RemovalApplyDeps
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
      // The identity the coverage matrix uses, so a retained set can name the
      // resources it holds rather than counting anonymous entries.
      resourceKey: operation.resourceKey,
      // What the apply left at the destination is *nothing*, so undo compares
      // against the removed content: a path recreated with different bytes
      // after the removal is a change undo must not silently discard.
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

/**
 * The path the registry derives must be the one the preview showed. They are
 * built from the same definition, so a disagreement means the environment moved
 * under the request — and the one operation that must never act on a guess
 * about which file it is about to delete is this one.
 */
function assertPreviewedPath(
  operation: PlannedRemoval,
  location: LocationDefinition,
  logicalPath: string
): void {
  if (resolvePath(logicalPath) === resolvePath(operation.expectedPath)) return;
  throw new GuardError(
    `"${operation.resourceKey}" resolves to "${logicalPath}" at "${location.id}", not the previewed "${operation.expectedPath}".`
  );
}

/**
 * Renames every staged tree back, newest first. Returns the stage paths whose
 * compensation failed — empty means the disk is exactly as it was, and anything
 * else is the one case where the backups must be kept and the apply reported as
 * partial.
 */
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

/**
 * The copies a failed compensation really did leave gone. Anything the rollback
 * put back is on disk and must not be reported as removed — the response is
 * what the caller reads to decide which paths still need restoring.
 */
function stillRemoved(
  results: readonly StagedOperation[],
  unrestored: ReadonlySet<string>
): RemovalRemoved[] {
  return results
    .filter((result) => unrestored.has(result.staged.stagePath))
    .map((result) => result.removed);
}

/**
 * The copies a compensation did put back. They sit on disk exactly as they did
 * before the apply, so the caller has to see them as kept — reporting them
 * nowhere at all would leave a location the user reviewed unaccounted for.
 */
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

/**
 * The copies the apply stopped short of. Staging halts at the first failure, so
 * every operation after it was planned, shown to the user, and then silently
 * skipped. `staged` is how many succeeded; the one at that index is the failure
 * already recorded in `failed`.
 */
function notAttempted(operations: readonly PlannedRemoval[], staged: number): RemovalKept[] {
  return operations.slice(staged + 1).map((operation) => ({
    resourceKey: operation.resourceKey,
    locationId: operation.locationId,
    reason: 'not-attempted' as const,
  }));
}

class GuardError extends Error {}
class BackupError extends Error {}

function describeFailure(operation: PlannedRemoval, error: unknown): RemovalFailure {
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

function validationError(message: string): LibraryRequestError {
  return new LibraryRequestError(422, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
