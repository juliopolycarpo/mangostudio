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

import type { RuntimeLibraryRemoveParams } from '@mangostudio/runtime';
import {
  executeRemovalWrites,
  type PreparedRemovalOperation,
  type RemovalWriteEngineDeps,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  RemovalApply,
  RemovalApplyRequest,
  RemovalKept,
  RemovalPreview,
  RemovalPreviewEntry,
  RemovalPreviewRequest,
} from '@mangostudio/shared/library';
import { getLibraryLocation } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { assertRequestedProfileId, ProfileMismatchError } from '../../../lib/profile-context';
import { getRuntimeClient } from '../../../services/runtime-client';
import { constantTimeEquals } from '../../../utils/hash';
import { LibraryRequestError } from '../domain/library-request-error';
import { backupPolicyFor } from '../infrastructure/backup-roots';
import { type BackupStoreDeps, defaultBackupStoreDeps } from '../infrastructure/backup-store';
import { hashResourceAt } from '../infrastructure/instance-reader';
import { configuredLibraryEnv, createLibraryPathEnv } from '../infrastructure/location-probe';
import { nodeTreeRemovalFs, type TreeRemovalFs } from '../infrastructure/tree-removal';
import { serializeLibraryWrite } from './apply-queue';
import { recordWrittenBackup } from './backup-inventory';
import { compareText } from './preview-state';
import { previewLibraryRemoval } from './removal-preview';

/** Matches library reads: hub deadline sits above runtime write work. */
const LIBRARY_WRITE_TIMEOUT_MS = 60_000;

export interface RemovalApplyDeps {
  preview(userId: string, request: RemovalPreviewRequest): Promise<RemovalPreview>;
  /** Layout of one machine; see `PropagationApplyDeps.pathEnv`. */
  pathEnv(environmentId: string): PathEnv;
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  backup: BackupStoreDeps;
  treeFs: TreeRemovalFs;
  /** Which process performs the writes; see `PropagationApplyDeps.writeEngine`. */
  writeEngine: 'runtime' | 'in-process';
  /** Stands in for the RuntimeClient on the `runtime` engine. */
  runtimeRemove?: (params: RuntimeLibraryRemoveParams) => Promise<RemovalApply>;
  /** Which machine the copies are removed from; see `PropagationApplyDeps`. */
  environmentId: string;
  /** Files the produced backup set in the hub-side listing index. */
  recordBackup: (
    userId: string,
    input: {
      readonly environmentId: string;
      readonly backupId: string;
      readonly operation: 'propagation' | 'removal';
      readonly pinned: boolean;
      readonly createdAtMs: number;
    }
  ) => Promise<void>;
}

function resolveDeps(overrides: Partial<RemovalApplyDeps>): RemovalApplyDeps {
  return {
    preview: overrides.preview ?? previewLibraryRemoval,
    pathEnv: overrides.pathEnv ?? (() => createLibraryPathEnv()),
    hashAt: overrides.hashAt ?? hashResourceAt,
    backup: overrides.backup ?? defaultBackupStoreDeps,
    treeFs: overrides.treeFs ?? nodeTreeRemovalFs,
    writeEngine: overrides.writeEngine ?? 'runtime',
    environmentId: overrides.environmentId ?? LOCAL_ENVIRONMENT_ID,
    recordBackup: overrides.recordBackup ?? recordWrittenBackup,
    ...(overrides.runtimeRemove && { runtimeRemove: overrides.runtimeRemove }),
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
  // Grouped by the machine the copies are on, insertion-ordered so two
  // identical removals touch the same machines in the same order.
  const batches = new Map<string, PreparedRemovalOperation[]>();
  for (const operation of plan.operations) {
    const wire: PreparedRemovalOperation = {
      resourceKey: operation.resourceKey,
      locationId: operation.locationId,
      slug: operation.slug,
      kind: operation.kind,
      expectedPath: operation.expectedPath,
      expectedContentHash: operation.expectedContentHash,
      lastCopy: operation.lastCopy,
    };
    const batch = batches.get(operation.environmentId);
    if (batch) batch.push(wire);
    else batches.set(operation.environmentId, [wire]);
  }

  // The plan's own `kept` entries are merged here rather than shipped and
  // echoed: the hub decided them, and the engine returns only what it kept
  // itself — rolled back, or never attempted.
  const removalResult = await runRemovalAcrossEnvironments(userId, batches, plan, deps);
  // Pinned when it holds someone's last copy: the set is the only remaining
  // instance of that resource, and the index has to know that before retention
  // on the owning machine is ever asked about it.
  for (const handle of removalResult.backups) {
    await deps
      .recordBackup(userId, {
        environmentId: handle.environmentId,
        backupId: handle.backupId,
        operation: 'removal',
        pinned: plan.lastCopyResourceKeys.length > 0,
        createdAtMs: Date.now(),
      })
      .catch((error: unknown) => {
        console.error('[library] Could not index the backup set for this removal:', error);
      });
  }
  return { ...removalResult, kept: [...plan.kept, ...removalResult.kept] };
}

/**
 * One removal batch per machine, in a fixed order.
 *
 * A machine that fails stops the rest, and it matters more here than it does in
 * propagation: every batch already gone is a set of files that only exist inside
 * a backup, so the fewer machines a failed removal has touched, the less there
 * is to put back.
 */
async function runRemovalAcrossEnvironments(
  userId: string,
  batches: ReadonlyMap<string, PreparedRemovalOperation[]>,
  plan: RemovalPlan,
  deps: RemovalApplyDeps
): Promise<RemovalApply> {
  const removed: RemovalApply['removed'] = [];
  const kept: RemovalApply['kept'] = [];
  const failed: RemovalApply['failed'] = [];
  const backups: RemovalApply['backups'] = [];
  let partial = false;

  for (const [environmentId, operations] of batches) {
    const batch = await runWriteEngine(userId, operations, plan, deps.pathEnv(environmentId), {
      ...deps,
      environmentId,
    });
    removed.push(...batch.removed);
    kept.push(...batch.kept);
    failed.push(...batch.failed);
    backups.push(...batch.backups);
    partial ||= batch.partial;
    // A clean compensation only covers *that* machine's own disk: once an
    // earlier machine already landed a backup, this failure still leaves the
    // removal partially done overall.
    if (batch.failed.length > 0) {
      if (backups.length > batch.backups.length) partial = true;
      break;
    }
  }

  return {
    partial,
    removed,
    kept,
    failed,
    backups,
    // Only when one machine was touched: a cross-machine removal has one
    // irreplaceable set per machine, and naming one is how a user restores half
    // of what they lost believing they restored all of it.
    ...(backups.length === 1 && { backupId: backups[0].backupId }),
  };
}

function runWriteEngine(
  userId: string,
  operations: readonly PreparedRemovalOperation[],
  plan: RemovalPlan,
  env: PathEnv,
  deps: RemovalApplyDeps
): Promise<RemovalApply> {
  if (deps.writeEngine === 'in-process') {
    const engineDeps: RemovalWriteEngineDeps = {
      hashAt: deps.hashAt,
      backup: deps.backup,
      treeFs: deps.treeFs,
    };
    return executeRemovalWrites(
      {
        backupRoot: deps.backup.backupDir(),
        retentionCount: deps.backup.retentionCount(),
        retentionBytes: deps.backup.retentionBytes(),
        pathEnv: env,
        environmentId: deps.environmentId,
        operations,
        lastCopyResourceKeys: plan.lastCopyResourceKeys,
      },
      engineDeps
    );
  }

  const params = toRuntimeRemoveParams(operations, plan, env, deps);
  return deps.runtimeRemove ? deps.runtimeRemove(params) : runtimeRemove(userId, params, deps);
}

async function runtimeRemove(
  userId: string,
  params: RuntimeLibraryRemoveParams,
  deps: RemovalApplyDeps
): Promise<RemovalApply> {
  const client = await getRuntimeClient(userId, deps.environmentId);
  // Resolved from the connection: a remote store roots at the target's home.
  const policy = backupPolicyFor(client, deps.environmentId);
  return await client.library.remove(
    {
      ...params,
      backupRoot: policy.backupRoot,
      retentionCount: policy.retentionCount,
      retentionBytes: policy.retentionBytes,
    },
    { timeoutMs: LIBRARY_WRITE_TIMEOUT_MS }
  );
}

function toRuntimeRemoveParams(
  operations: readonly PreparedRemovalOperation[],
  plan: RemovalPlan,
  env: PathEnv,
  deps: RemovalApplyDeps
): RuntimeLibraryRemoveParams {
  const backup = deps.backup;
  return {
    backupRoot: backup.backupDir(),
    retentionCount: backup.retentionCount(),
    retentionBytes: backup.retentionBytes(),
    environmentId: deps.environmentId,
    pathEnv: {
      // Only the MangoStudio directories travel, matching `pathEnvParams` in
      // `environment-library-service.ts`; the runtime merges its own
      // `process.env` underneath, so forwarding the hub's would only put its
      // secrets in the frame.
      env: configuredLibraryEnv(),
      ...(env.workspaceRoot !== undefined && { workspaceRoot: env.workspaceRoot }),
    },
    operations,
    lastCopyResourceKeys: [...plan.lastCopyResourceKeys],
  };
}

/** A copy is the machine and the location; neither identifies one alone. */
function placementKey(environmentId: string, locationId: string): string {
  return `${environmentId}\u001f${locationId}`;
}

interface PlannedRemoval {
  readonly resourceKey: string;
  /** Machine the copy is removed from. */
  readonly environmentId: string;
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
      const key = placementKey(target.environmentId ?? LOCAL_ENVIRONMENT_ID, target.locationId);
      if (decided.has(key)) {
        throw validationError(
          `Duplicate decision for location "${target.locationId}" on "${target.environmentId ?? LOCAL_ENVIRONMENT_ID}" of "${entry.resourceKey}".`
        );
      }
      decided.set(key, target.action);
    }
    // The same rule propagation applies to destinations: every copy the preview
    // showed comes back explicitly removed or kept, so the response can never be
    // silent about somewhere the user was shown.
    const offered = new Set(
      entry.locations.map((location) => placementKey(location.environmentId, location.locationId))
    );
    const missing = entry.locations
      .filter((location) => !decided.has(placementKey(location.environmentId, location.locationId)))
      .map((location) => `"${location.locationId}" on "${location.environmentId}"`);
    if (missing.length > 0) {
      throw validationError(
        `Apply must decide every location the preview offered for "${entry.resourceKey}"; missing ${missing.join(', ')}.`
      );
    }
    for (const key of decided.keys()) {
      if (!offered.has(key)) {
        throw validationError(
          `Location "${key.split('\u001f')[1]}" was not offered for "${entry.resourceKey}".`
        );
      }
    }

    const removing = new Set<string>();
    for (const location of entry.locations) {
      const action = decided.get(placementKey(location.environmentId, location.locationId));
      if (action !== 'remove') {
        kept.push({
          resourceKey: entry.resourceKey,
          environmentId: location.environmentId,
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
      removing.add(placementKey(location.environmentId, location.locationId));
      operations.push({
        resourceKey: entry.resourceKey,
        environmentId: location.environmentId,
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
    // Against every copy that exists on every machine in scope, not against the
    // rows on screen: a copy surviving on another box is a surviving copy.
    const zeroesResource = entry.instancePlacements.every((placement) =>
      removing.has(placementKey(placement.environmentId, placement.locationId))
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

function validationError(message: string): LibraryRequestError {
  return new LibraryRequestError(422, message);
}
