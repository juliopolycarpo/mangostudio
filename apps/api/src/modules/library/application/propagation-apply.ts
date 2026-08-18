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

import type { RuntimeLibraryApplyParams, RuntimeLibraryUndoParams } from '@mangostudio/runtime';
import {
  executeLibraryUndo,
  executePropagationWrites,
  LIBRARY_BACKUP_MISSING_KIND,
  LibraryBackupMissingError,
  type PreparedPropagationFile,
  type PreparedPropagationOperation,
  type PropagationWriteEngineDeps,
  RuntimeRemoteError,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  type AdapterStrategy,
  hashLibraryFile,
  type LibraryDivergenceAckRequest,
  type LibraryUndoResult,
  type PropagationApplied,
  type PropagationApply,
  type PropagationApplyRequest,
  type PropagationDecision,
  type PropagationDestination,
  type PropagationFailure,
  type PropagationPreview,
  type PropagationPreviewEntry,
  type PropagationPreviewRequest,
  type PropagationSkipped,
  type PropagationSourceGroup,
  type PropagationUndo,
  type ResourceFormat,
  type ResourceKind,
} from '@mangostudio/shared/library';
import { getLibraryLocation, type LocationDefinition } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { assertRequestedProfileId, ProfileMismatchError } from '../../../lib/profile-context';
import { getRuntimeClient } from '../../../services/runtime-client';
import { constantTimeEquals } from '../../../utils/hash';
import { LibraryRequestError } from '../domain/library-request-error';
import { backupPolicyFor } from '../infrastructure/backup-roots';
import { type BackupStoreDeps, defaultBackupStoreDeps } from '../infrastructure/backup-store';
import { hashResourceAt, readResourceFile } from '../infrastructure/instance-reader';
import { configuredLibraryEnv, createLibraryPathEnv } from '../infrastructure/location-probe';
import {
  type ResourceWriteResult,
  writeDirectoryResource,
  writeFileResource,
} from '../infrastructure/resource-writer';
import { defaultAdapterRegistry } from './adapters/registry';
import type { AdaptInput, AdaptResult, AdaptSuccess } from './adapters/types';
import { serializeLibraryWrite } from './apply-queue';
import { recordWrittenBackup } from './backup-inventory';
import { acknowledgeDivergence } from './conflict-resolution';
import { resetLibraryCachesForEnvironments } from './environment-library-service';
import { previewLibraryPropagation } from './propagation-preview';

/** Matches library reads: hub deadline sits above runtime write work. */
const LIBRARY_WRITE_TIMEOUT_MS = 60_000;

export interface PropagationApplyDeps {
  preview(userId: string, request: PropagationPreviewRequest): Promise<PropagationPreview>;
  /**
   * Path layout of one machine.
   *
   * Only the in-process engine consults it — over the protocol the runtime
   * resolves its own layout and is sent nothing but the MangoStudio directory
   * overrides. The parameter exists so a test can stand up two machines with
   * two homes; production answers with the hub's own env for every id, because
   * the hub cannot know another machine's.
   */
  pathEnv(environmentId: string): PathEnv;
  readSourceFile(path: string): Promise<Uint8Array>;
  /**
   * Reads a resource off the machine that holds it, as bytes.
   *
   * Only used when the source is *not* Local: the hub shares a filesystem with
   * the Local runtime, so reading there directly keeps every existing path and
   * every existing test byte-for-byte what they were. A directory answers as its
   * whole tree; a file as a single entry. Never text — the apply re-hashes what
   * it wrote, and a UTF-8 round trip would drop a BOM and fail verification on
   * content that was perfectly fine.
   */
  readRemoteSource(
    userId: string,
    environmentId: string,
    input: { readonly locationId: string; readonly path: string }
  ): Promise<readonly PreparedPropagationFile[]>;
  writeDirectory(input: DirectoryWrite): Promise<ResourceWriteResult>;
  writeFile(input: FileWrite): Promise<ResourceWriteResult>;
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  adapt(input: AdaptInput, strategy: AdapterStrategy): Promise<AdaptResult>;
  acknowledge(userId: string, request: LibraryDivergenceAckRequest): Promise<unknown>;
  backup: BackupStoreDeps;
  /**
   * Which process performs the writes. `runtime` — the default — sends them
   * over the protocol; `in-process` runs the engine here against the injected
   * fs seams, which is what the parity suites exercise.
   *
   * Stated rather than inferred. This used to be decided by sniffing the
   * options bag for anything test-shaped, so a caller overriding `backup` to
   * point at a different backup root — the shape `describeBackupUsage` already
   * accepts — silently stopped using the runtime, and a suite could look like
   * it covered the RPC path while never touching it.
   */
  writeEngine: 'runtime' | 'in-process';
  /** Stands in for the RuntimeClient on the `runtime` engine; tests inject transport failures. */
  runtimeApply?: (params: RuntimeLibraryApplyParams) => Promise<PropagationApply>;
  /**
   * Which machine the writes land on. Every destination is Local until the
   * wizards offer a second one; the field exists from the first commit so the
   * backup set an apply produces can be filed under the machine that holds it
   * rather than under an assumption.
   */
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
  /**
   * Drops cached location health for machines this write touched. Location
   * listing shares the probing TTL, so a create would otherwise keep reporting
   * the pre-write exists/entryCount until that window closes.
   */
  resetCaches(rows: Iterable<{ readonly environmentId: string }>): void;
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
  readonly contents: string | Uint8Array;
  readonly env: PathEnv;
  readonly backupId: string;
}

function resolveDeps(overrides: Partial<PropagationApplyDeps>): PropagationApplyDeps {
  return {
    preview: overrides.preview ?? previewLibraryPropagation,
    pathEnv: overrides.pathEnv ?? (() => createLibraryPathEnv()),
    readSourceFile: overrides.readSourceFile ?? readResourceFile,
    readRemoteSource: overrides.readRemoteSource ?? readRemoteLibrarySource,
    writeDirectory:
      overrides.writeDirectory ??
      ((input) => writeDirectoryResource({ ...input, locationId: input.locationId })),
    writeFile:
      overrides.writeFile ??
      ((input) => writeFileResource({ ...input, locationId: input.locationId })),
    hashAt: overrides.hashAt ?? hashResourceAt,
    adapt: overrides.adapt ?? ((input, strategy) => defaultAdapterRegistry.adapt(input, strategy)),
    acknowledge: overrides.acknowledge ?? acknowledgeDivergence,
    backup: overrides.backup ?? defaultBackupStoreDeps,
    writeEngine: overrides.writeEngine ?? 'runtime',
    environmentId: overrides.environmentId ?? LOCAL_ENVIRONMENT_ID,
    recordBackup: overrides.recordBackup ?? recordWrittenBackup,
    resetCaches: overrides.resetCaches ?? resetLibraryCachesForEnvironments,
    ...(overrides.runtimeApply && { runtimeApply: overrides.runtimeApply }),
  };
}

async function readRemoteLibrarySource(
  userId: string,
  environmentId: string,
  input: { readonly locationId: string; readonly path: string }
): Promise<readonly PreparedPropagationFile[]> {
  const client = await getRuntimeClient(userId, environmentId);
  const result = await client.library.readTree(
    {
      path: input.path,
      locationId: input.locationId,
      pathEnv: { env: configuredLibraryEnv() },
    },
    { timeoutMs: LIBRARY_WRITE_TIMEOUT_MS }
  );
  if (result.denied) {
    throw new SourceReadError(
      result.reason ?? `"${input.path}" could not be read on environment "${environmentId}".`
    );
  }
  return result.files.map((file) => ({
    relativePath: file.relativePath,
    contents: Buffer.from(file.contentBase64, 'base64'),
  }));
}

export function applyLibraryPropagation(
  userId: string,
  request: PropagationApplyRequest,
  overrides: Partial<PropagationApplyDeps> = {}
): Promise<PropagationApply> {
  return serializeLibraryWrite(() => runApply(userId, request, resolveDeps(overrides)));
}

async function runApply(
  userId: string,
  request: PropagationApplyRequest,
  deps: PropagationApplyDeps
): Promise<PropagationApply> {
  try {
    assertRequestedProfileId(request.profileId, { userId });
  } catch (error) {
    if (error instanceof ProfileMismatchError) {
      throw new LibraryRequestError(400, error.message);
    }
    throw error;
  }
  const preview = await deps.preview(userId, request.request);
  // Both must match: the token pins which preview this answers, the state hash
  // pins the bytes it described. A file edited in another window between the
  // two calls fails here instead of being silently overwritten.
  if (
    !constantTimeEquals(preview.previewToken, request.previewToken) ||
    !constantTimeEquals(preview.stateHash, request.stateHash)
  ) {
    throw new LibraryRequestError(
      409,
      'The library changed since this preview was taken. Preview again before applying.'
    );
  }

  const plan = planApply(preview, request.decisions);
  // Grouped by destination machine, insertion-ordered: the plan is already
  // sorted by resource then machine then location, so two identical applies
  // write the same machines in the same order.
  const batches = new Map<string, PreparedPropagationOperation[]>();
  const failed: PropagationFailure[] = [];

  for (const operation of plan.operations) {
    try {
      const wire = await prepareOperation(operation, userId, deps);
      const batch = batches.get(operation.environmentId);
      if (batch) batch.push(wire);
      else batches.set(operation.environmentId, [wire]);
    } catch (error) {
      failed.push(describePrepareFailure(operation, error));
      break;
    }
  }

  if (failed.length > 0) {
    return { partial: false, applied: [], skipped: plan.skipped, failed, backups: [] };
  }

  const writeResult = await runPreparedWrites(userId, batches, plan.skipped, deps);

  // Indexed even when the apply was partial: a partial apply is precisely the
  // one whose backup handles the user needs to find again later, and a failure
  // to file a row must not turn a completed write into a reported failure.
  for (const handle of writeResult.backups) {
    await deps
      .recordBackup(userId, {
        environmentId: handle.environmentId,
        backupId: handle.backupId,
        operation: 'propagation',
        pinned: false,
        createdAtMs: Date.now(),
      })
      .catch((error: unknown) => {
        console.error('[library] Could not index the backup set for this apply:', error);
      });
  }

  if (writeResult.failed.length === 0) {
    for (const acknowledgement of plan.acknowledgements) {
      await deps.acknowledge(userId, acknowledgement);
    }
  }

  deps.resetCaches([...writeResult.applied, ...writeResult.backups]);
  return writeResult;
}

/**
 * `skipped` is merged here rather than sent and echoed. The plan already holds
 * it, so shipping it to the engine only to read it back would put it on the
 * wire twice and give the write engines a field they never decide anything
 * from. Both engine paths return an empty array.
 */
async function runPreparedWrites(
  userId: string,
  batches: ReadonlyMap<string, PreparedPropagationOperation[]>,
  skipped: readonly PropagationSkipped[],
  deps: PropagationApplyDeps
): Promise<PropagationApply> {
  if (batches.size === 0) {
    return { partial: false, applied: [], skipped: [...skipped], failed: [], backups: [] };
  }

  const written = await runWriteEngineAcrossEnvironments(userId, batches, deps);
  return { ...written, skipped: [...skipped, ...written.skipped] };
}

/**
 * Runs one write batch per destination machine, in a fixed order.
 *
 * Each machine backs its own files up under its own root, so a cross-machine
 * apply produces one backup set per machine rather than one for the whole thing.
 * Machines are written one after another rather than in parallel: an apply that
 * fails partway should leave as few machines touched as possible, and the
 * per-machine engine already compensates its own writes.
 */
async function runWriteEngineAcrossEnvironments(
  userId: string,
  batches: ReadonlyMap<string, PreparedPropagationOperation[]>,
  deps: PropagationApplyDeps
): Promise<PropagationApply> {
  const applied: PropagationApply['applied'] = [];
  const skipped: PropagationApply['skipped'] = [];
  const failed: PropagationApply['failed'] = [];
  const backups: PropagationApply['backups'] = [];
  let partial = false;

  for (const [environmentId, operations] of batches) {
    const batch = await runWriteEngine(userId, operations, deps.pathEnv(environmentId), {
      ...deps,
      environmentId,
    });
    applied.push(...batch.applied);
    skipped.push(...batch.skipped);
    failed.push(...batch.failed);
    backups.push(...batch.backups);
    partial ||= batch.partial;
    // A machine that failed stops the rest. Carrying on would spread a
    // half-applied change across more hosts and give the user more to undo,
    // not less — and every machine already compensated its own writes. But a
    // clean compensation only covers *that* machine's own disk: once an
    // earlier machine already landed a backup, this failure still leaves the
    // apply partially done overall.
    if (batch.failed.length > 0) {
      if (backups.length > batch.backups.length) partial = true;
      break;
    }
  }

  return {
    partial,
    applied,
    skipped,
    failed,
    backups,
    // Only when one machine was written to. A cross-machine apply has no single
    // undo handle, and offering one would name whichever set happened to be
    // first.
    ...(backups.length === 1 && { backupId: backups[0].backupId }),
  };
}

function runWriteEngine(
  userId: string,
  prepared: readonly PreparedPropagationOperation[],
  env: PathEnv,
  deps: PropagationApplyDeps
): Promise<PropagationApply> {
  if (deps.writeEngine === 'in-process') {
    const engineDeps: PropagationWriteEngineDeps = {
      writeDirectory: deps.writeDirectory,
      writeFile: deps.writeFile,
      hashAt: deps.hashAt,
      backup: deps.backup,
    };
    return executePropagationWrites(
      {
        backupRoot: deps.backup.backupDir(),
        retentionCount: deps.backup.retentionCount(),
        retentionBytes: deps.backup.retentionBytes(),
        pathEnv: env,
        environmentId: deps.environmentId,
        operations: prepared,
      },
      engineDeps
    );
  }

  if (deps.runtimeApply) {
    return deps.runtimeApply(toRuntimeApplyParams(prepared, env, deps, backupEnvelopeFrom(deps)));
  }
  return runtimeApply(userId, prepared, env, deps);
}

async function runtimeApply(
  userId: string,
  prepared: readonly PreparedPropagationOperation[],
  env: PathEnv,
  deps: PropagationApplyDeps
): Promise<PropagationApply> {
  const client = await getRuntimeClient(userId, deps.environmentId);
  // Resolved from the connection rather than from hub config: a remote store
  // roots at the *target's* home, and 017 made this a parameter precisely so the
  // decision could be made here.
  const policy = backupPolicyFor(client, deps.environmentId);
  const params = toRuntimeApplyParams(prepared, env, deps, {
    backupRoot: policy.backupRoot,
    retentionCount: policy.retentionCount,
    retentionBytes: policy.retentionBytes,
  });
  return await client.library.apply(params, { timeoutMs: LIBRARY_WRITE_TIMEOUT_MS });
}

/**
 * Bounds for an injected engine. Tests redirect `backup` to a temp root, and
 * that override has to keep deciding where a write lands.
 */
function backupEnvelopeFrom(deps: PropagationApplyDeps): {
  backupRoot: string;
  retentionCount: number;
  retentionBytes: number;
} {
  return {
    backupRoot: deps.backup.backupDir(),
    retentionCount: deps.backup.retentionCount(),
    retentionBytes: deps.backup.retentionBytes(),
  };
}

/**
 * Raw bytes one `library.apply` frame may carry across all of its operations.
 *
 * Base64 inflates by 4/3, so this leaves roughly 5 MiB under
 * `RUNTIME_MAX_FRAME_BYTES` for the envelope, the operation list, and the
 * skipped entries. Deliberately below the ceiling rather than at it: hitting
 * the codec limit throws inside `cloneFrame`, which only validates outside
 * production, so an apply that failed in dev would have gone out on the wire in
 * production and been dropped by the transport instead.
 */
const LIBRARY_APPLY_MAX_CONTENT_BYTES = 8 * 1024 * 1024;

function toRuntimeApplyParams(
  prepared: readonly PreparedPropagationOperation[],
  env: PathEnv,
  deps: PropagationApplyDeps,
  envelope: { backupRoot: string; retentionCount: number; retentionBytes: number }
): RuntimeLibraryApplyParams {
  // Keyed by content hash so a resource fanned out to many destinations travels
  // once. `expectedContentHash` is the hash of exactly these bytes by
  // construction — `prepareOperation` recomputes it whenever adaptation or an
  // edit changes them — so equal keys mean equal payloads.
  const contents: Record<string, string> = {};
  let contentBytes = 0;
  const carry = (key: string, bytes: Uint8Array): void => {
    if (contents[key] !== undefined) return;
    const buffer = Buffer.from(bytes);
    contentBytes += buffer.byteLength;
    if (contentBytes > LIBRARY_APPLY_MAX_CONTENT_BYTES) {
      throw new LibraryRequestError(
        422,
        'This apply carries more content than one write can send. Apply fewer resources at a time.'
      );
    }
    contents[key] = buffer.toString('base64');
  };

  for (const operation of prepared) {
    if (operation.contents !== undefined) {
      carry(
        operation.expectedContentHash,
        typeof operation.contents === 'string'
          ? new TextEncoder().encode(operation.contents)
          : operation.contents
      );
    }
    for (const file of operation.files ?? []) {
      carry(treeFileKey(operation.expectedContentHash, file.relativePath), file.contents);
    }
  }

  return {
    ...envelope,
    environmentId: deps.environmentId,
    pathEnv: writePathEnvParams(env),
    operations: prepared.map(({ contents: _bytes, files, ...operation }) => ({
      ...operation,
      ...(operation.kind === 'file' && { contentRef: operation.expectedContentHash }),
      ...(files && {
        files: files.map((file) => ({
          relativePath: file.relativePath,
          contentRef: treeFileKey(operation.expectedContentHash, file.relativePath),
        })),
      }),
    })),
    contents,
  };
}

/**
 * Payload key for one file of a transferred tree.
 *
 * Keyed by the resource's content hash plus the path inside it, so a skill
 * fanned out to several destinations carries its files once — and two different
 * skills that happen to contain an identically named file never collide.
 */
function treeFileKey(contentHash: string, relativePath: string): string {
  return `${contentHash}:${relativePath}`;
}

/**
 * Only the MangoStudio directories travel, exactly as `pathEnvParams` in
 * `environment-library-service.ts` sends them: they are hub configuration
 * rather than a fact about the host, and the runtime already merges its own
 * `process.env` underneath. Forwarding the hub's whole environment would put
 * its secrets in every write frame for no added resolution.
 */
function writePathEnvParams(env: PathEnv): RuntimeLibraryApplyParams['pathEnv'] {
  return {
    env: configuredLibraryEnv(),
    ...(env.workspaceRoot !== undefined && { workspaceRoot: env.workspaceRoot }),
  };
}

function narrowAppliedOperation(
  operation: PropagationApplied['operation']
): 'create' | 'overwrite' | 'adapt-create' | 'adapt-overwrite' {
  if (
    operation === 'create' ||
    operation === 'overwrite' ||
    operation === 'adapt-create' ||
    operation === 'adapt-overwrite'
  ) {
    return operation;
  }
  throw new TypeError(`Prepared library write cannot carry operation "${operation}".`);
}

interface PlannedOperation {
  readonly resourceKey: string;
  /** Machine the write lands on. */
  readonly environmentId: string;
  readonly locationId: string;
  readonly slug: string;
  readonly operation: PropagationApplied['operation'];
  readonly kind: 'file' | 'directory';
  readonly sourcePath: string;
  /** Machine the winning bytes are read from; empty for edited content. */
  readonly sourceEnvironmentId: string;
  /** Location the winning bytes are read from, needed to contain a remote read. */
  readonly sourceLocationId: string;
  readonly editedContent?: string;
  readonly expectedContentHash: string;
  /** Location root the preview showed; the runtime refuses a different one. */
  readonly destinationRoot: string;
  readonly adaptation?: {
    readonly strategy: AdapterStrategy;
    readonly kind: ResourceKind;
    readonly from: ResourceFormat;
    readonly to: ResourceFormat;
    readonly sourceLocationId: string;
  };
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
      // No location and no machine: keeping a divergence is a decision about the
      // resource everywhere, not about one copy of it.
      skipped.push({
        resourceKey: entry.resourceKey,
        environmentId: LOCAL_ENVIRONMENT_ID,
        reason: 'divergence-acknowledged',
      });
      continue;
    }

    const winner = resolveWinner(entry, decision);
    if (decision.resolution === 'edit-then-adopt') assertOneEditedFormat(entry, decision);
    assertEveryDestinationDecided(entry, decision);
    for (const target of decision.destinations) {
      const environmentId = target.environmentId ?? LOCAL_ENVIRONMENT_ID;
      const destination = entry.destinations.find(
        (candidate) =>
          candidate.locationId === target.locationId && candidate.environmentId === environmentId
      );
      if (!destination) {
        throw validationError(
          `Destination "${target.locationId}" on "${environmentId}" was not offered for "${entry.resourceKey}".`
        );
      }
      if (target.action === 'skip') {
        skipped.push({
          resourceKey: entry.resourceKey,
          environmentId,
          locationId: target.locationId,
          reason: 'user-skipped',
        });
        continue;
      }
      const planned = planDestination(entry, decision, winner, destination, target.strategy);
      if (planned === null) {
        skipped.push({
          resourceKey: entry.resourceKey,
          environmentId,
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
      compareText(left.environmentId, right.environmentId) ||
      compareText(left.locationId, right.locationId)
  );
  return { operations, skipped, acknowledgements };
}

/**
 * The same rule as one-decision-per-entry, a level down: every destination the
 * preview offered comes back explicitly applied or skipped. A dropped
 * destination would otherwise land in neither `applied` nor `skipped`, so the
 * response would not say what happened to a location the user was shown — and
 * an off-by-one in a client's destination list would read as a clean apply.
 */
function assertEveryDestinationDecided(
  entry: PropagationPreviewEntry,
  decision: PropagationDecision
): void {
  const decided = new Set<string>();
  for (const target of decision.destinations) {
    const key = destinationKey(target.environmentId ?? LOCAL_ENVIRONMENT_ID, target.locationId);
    if (decided.has(key)) {
      throw validationError(
        `Duplicate decision for destination "${target.locationId}" on "${target.environmentId ?? LOCAL_ENVIRONMENT_ID}" of "${entry.resourceKey}".`
      );
    }
    decided.add(key);
  }

  const missing = entry.destinations
    .filter(
      (destination) =>
        !decided.has(destinationKey(destination.environmentId, destination.locationId))
    )
    .map((destination) => `"${destination.locationId}" on "${destination.environmentId}"`);
  if (missing.length > 0) {
    throw validationError(
      `Apply must decide every destination the preview offered for "${entry.resourceKey}"; missing ${missing.join(', ')}.`
    );
  }
}

/**
 * One edit is one set of bytes, and there is no adapter to convert it, so every
 * destination it is applied to has to store the same format. Fanning a hand-
 * merged markdown file out to a `.mdc` or `.toml` location would write text no
 * reader there can parse — the very case `adopt-group` reports as
 * `blocked / no-adapter-strategy`.
 */
/** A destination is the machine and the location; neither identifies one alone. */
function destinationKey(environmentId: string, locationId: string): string {
  return `${environmentId}\u001f${locationId}`;
}

function assertOneEditedFormat(
  entry: PropagationPreviewEntry,
  decision: PropagationDecision
): void {
  const formats = new Set(
    decision.destinations.flatMap((target) => {
      if (target.action !== 'apply') return [];
      const destination = entry.destinations.find(
        (candidate) =>
          candidate.locationId === target.locationId &&
          candidate.environmentId === (target.environmentId ?? LOCAL_ENVIRONMENT_ID)
      );
      return destination ? [destination.toFormat] : [];
    })
  );
  if (formats.size > 1) {
    throw validationError(
      `"${entry.resourceKey}" cannot adopt one edit into destinations of differing formats (${[...formats].sort(compareText).join(', ')}).`
    );
  }
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
  readonly sourceLocationId: string;
  /** Machine `sourcePath` is on. A path only means something on its own host. */
  readonly sourceEnvironmentId: string;
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
    return {
      contentHash: '',
      sourcePath: '',
      sourceLocationId: '',
      sourceEnvironmentId: '',
      editedContent: decision.editedContent,
    };
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
  return {
    contentHash: group.contentHash,
    sourcePath: group.contentPath,
    sourceLocationId: group.contentLocationId,
    sourceEnvironmentId: group.contentEnvironmentId,
  };
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
  // The preview leaves `path` null only where the location is unsupported, and
  // such a destination is always blocked above. Pinning it here is what lets
  // the write engine treat `destinationRoot` as the root the user approved and
  // refuse anything else; an empty-string stand-in would make that check a
  // no-op precisely when resolution disagrees.
  if (destination.path === null) {
    throw validationError(
      `Destination "${destination.locationId}" for "${entry.resourceKey}" has no path to write to.`
    );
  }

  if (decision.resolution === 'edit-then-adopt') {
    // Edited text is written verbatim, so it can only land where the format it
    // was written in is the format stored. Without this the branch would bypass
    // the outcome checks below and drop markdown into a `.mdc` or `.toml`
    // destination that `adopt-group` reports `blocked / no-adapter-strategy`.
    if (writeKindFor(location) !== 'file') {
      throw validationError(
        `"${entry.resourceKey}" cannot be adopted from edited text at directory location "${destination.locationId}".`
      );
    }
    return {
      resourceKey: entry.resourceKey,
      environmentId: destination.environmentId,
      locationId: destination.locationId,
      slug: entry.ref.slug,
      operation: destination.currentContentHash === undefined ? 'create' : 'overwrite',
      kind: 'file',
      sourcePath: '',
      sourceEnvironmentId: '',
      sourceLocationId: '',
      editedContent: winner.editedContent,
      expectedContentHash: '',
      destinationRoot: destination.path,
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
  const selectedStrategy = strategy;
  if (outcome.adaptation && selectedStrategy === undefined) {
    throw validationError(
      `Writing "${entry.resourceKey}" to "${destination.locationId}" requires an explicit adapter strategy.`
    );
  }

  return {
    resourceKey: entry.resourceKey,
    environmentId: destination.environmentId,
    locationId: destination.locationId,
    slug: entry.ref.slug,
    operation: outcome.operation,
    kind: writeKindFor(location),
    sourcePath: winner.sourcePath,
    sourceEnvironmentId: winner.sourceEnvironmentId,
    sourceLocationId: winner.sourceLocationId,
    expectedContentHash: winner.contentHash,
    destinationRoot: destination.path,
    ...(outcome.adaptation &&
      selectedStrategy && {
        adaptation: {
          strategy: selectedStrategy,
          kind: entry.ref.kind,
          from: outcome.adaptation.fromFormat,
          to: outcome.adaptation.toFormat,
          sourceLocationId: winner.sourceLocationId,
        },
      }),
  };
}

function writeKindFor(location: LocationDefinition): 'file' | 'directory' {
  return location.layout === 'directory-of-dirs' ? 'directory' : 'file';
}

/**
 * Hub-side preparation: read source bytes, run format adapters, compute the
 * expected post-write hash. The runtime write engine never adapts.
 */
async function prepareOperation(
  operation: PlannedOperation,
  userId: string,
  deps: PropagationApplyDeps
): Promise<PreparedPropagationOperation> {
  if (operation.kind === 'directory') {
    if (operation.adaptation) {
      throw new AdaptationError(
        `"${operation.resourceKey}" is a directory resource and cannot be adapted.`
      );
    }
    const base = {
      resourceKey: operation.resourceKey,
      locationId: operation.locationId,
      slug: operation.slug,
      operation: narrowAppliedOperation(operation.operation),
      kind: 'directory' as const,
      expectedContentHash: operation.expectedContentHash,
      destinationRoot: operation.destinationRoot,
    };
    // Same machine: the destination's own runtime can reach the source tree, so
    // it copies rather than receiving what it already has. Different machines:
    // the tree has to travel, because no path on the destination names it.
    if (operation.sourceEnvironmentId === operation.environmentId) {
      return { ...base, sourceDir: operation.sourcePath };
    }
    return {
      ...base,
      files: await readSourceTree(operation, userId, deps),
    };
  }

  let bytes =
    operation.editedContent === undefined
      ? await readSourceBytes(operation, userId, deps)
      : new TextEncoder().encode(operation.editedContent);
  let adaptation: PreparedPropagationOperation['adaptation'];
  if (operation.adaptation) {
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new AdaptationError('Source is not valid UTF-8 and cannot be adapted safely.');
    }
    const result: AdaptResult = await deps.adapt(
      {
        content,
        kind: operation.adaptation.kind,
        from: operation.adaptation.from,
        to: operation.adaptation.to,
        resourceKey: operation.resourceKey,
        sourceLocationId: operation.adaptation.sourceLocationId,
        targetLocationId: operation.locationId,
        userId,
      },
      operation.adaptation.strategy
    );
    if (!result.ok) throw new AdaptationError(clientFacingAdaptationMessage(result.error));
    const success: AdaptSuccess = result;
    adaptation = {
      strategy: operation.adaptation.strategy,
      lossy: success.lossy,
      requiresReview: success.requiresReview,
      notes: [...success.notes],
      ...(success.provenance && { provenance: success.provenance }),
    };
    bytes = new TextEncoder().encode(success.content);
  }
  const expectedContentHash =
    operation.editedContent === undefined && adaptation === undefined
      ? operation.expectedContentHash
      : (await hashLibraryFile(operation.destinationRoot, { readFile: () => bytes })).contentHash;

  return {
    resourceKey: operation.resourceKey,
    locationId: operation.locationId,
    slug: operation.slug,
    operation: narrowAppliedOperation(operation.operation),
    kind: 'file',
    expectedContentHash,
    destinationRoot: operation.destinationRoot,
    contents: bytes,
    ...(adaptation && { adaptation }),
  };
}

export interface PropagationUndoDeps {
  hashAt(path: string, kind: 'file' | 'directory'): Promise<string>;
  /** Layout of the machine holding the set; see `PropagationApplyDeps.pathEnv`. */
  pathEnv(environmentId: string): PathEnv;
  backup: BackupStoreDeps;
  /** Which process performs the restore; see `PropagationApplyDeps.writeEngine`. */
  writeEngine: 'runtime' | 'in-process';
  /** Stands in for the RuntimeClient on the `runtime` engine. */
  runtimeUndo?: (params: RuntimeLibraryUndoParams) => Promise<LibraryUndoResult>;
  /**
   * Which machine holds the backup set. Restoring reads the manifest where the
   * bytes are, so this is not a preference — asking the wrong machine finds
   * nothing and reports the set as pruned by retention.
   */
  environmentId: string;
  /**
   * Drops cached location health for the machine this restore touched. See
   * `PropagationApplyDeps.resetCaches`.
   */
  resetCaches(rows: Iterable<{ readonly environmentId: string }>): void;
}

/**
 * Restores every path an apply backed up and removes every path it created.
 *
 * A destination that changed after the apply is left alone rather than
 * reverted: undoing an apply must not also discard an edit the user made
 * afterwards, and silently doing so would be the same class of mistake the
 * state hash exists to prevent.
 *
 * `userId` selects the Local runtime connection for the production RPC path.
 * Injected backup/hash/runtimeUndo overrides keep unit tests in-process.
 */
export function undoLibraryPropagation(
  backupId: string,
  overrides: Partial<PropagationUndoDeps> = {},
  userId?: string
): Promise<PropagationUndo> {
  return serializeLibraryWrite(() => runUndo(backupId, overrides, userId));
}

async function runUndo(
  backupId: string,
  overrides: Partial<PropagationUndoDeps>,
  userId: string | undefined
): Promise<PropagationUndo> {
  const deps: PropagationUndoDeps = {
    hashAt: overrides.hashAt ?? hashResourceAt,
    pathEnv: overrides.pathEnv ?? (() => createLibraryPathEnv()),
    backup: overrides.backup ?? defaultBackupStoreDeps,
    writeEngine: overrides.writeEngine ?? 'runtime',
    environmentId: overrides.environmentId ?? LOCAL_ENVIRONMENT_ID,
    resetCaches: overrides.resetCaches ?? resetLibraryCachesForEnvironments,
    ...(overrides.runtimeUndo && { runtimeUndo: overrides.runtimeUndo }),
  };

  const env = deps.pathEnv(deps.environmentId);
  // Stamped by the hub, not the machine: the environment id is the hub's own
  // name for the connection, and a store reachable from two hubs would answer
  // with two different ones.
  const named = (result: LibraryUndoResult): PropagationUndo => {
    const undone = { ...result, environmentId: deps.environmentId };
    deps.resetCaches([undone]);
    return undone;
  };

  try {
    if (deps.writeEngine === 'in-process') {
      return named(
        await executeLibraryUndo(
          { backupRoot: deps.backup.backupDir(), backupId, pathEnv: env },
          { hashAt: deps.hashAt, backup: deps.backup }
        )
      );
    }

    if (deps.runtimeUndo) {
      return named(
        await deps.runtimeUndo({
          backupRoot: deps.backup.backupDir(),
          backupId,
          pathEnv: writePathEnvParams(env),
        })
      );
    }

    // Never defaulted: the connection cache is keyed by user, so a stand-in id
    // would open a second Local runtime host owned by a user that does not
    // exist rather than reusing the caller's.
    if (userId === undefined) {
      throw new TypeError('undoLibraryPropagation needs a userId to reach the Local runtime.');
    }
    const client = await getRuntimeClient(userId, deps.environmentId);
    // Same root apply wrote to: `deps.backup.backupDir()` only covers the
    // hub's own disk, and a remote apply backed its files up under the
    // target's own home via `backupPolicyFor` — undoing it has to look there.
    const policy = backupPolicyFor(client, deps.environmentId);
    const params = {
      backupRoot: policy.backupRoot,
      backupId,
      pathEnv: writePathEnvParams(env),
    };
    return named(await client.library.undo(params, { timeoutMs: LIBRARY_WRITE_TIMEOUT_MS }));
  } catch (error) {
    // Two shapes, one condition: the in-process engine throws the class, and
    // the RPC path flattens it to code INTERNAL carrying the kind in `details`.
    if (error instanceof LibraryBackupMissingError || isBackupMissingResponse(error)) {
      throw new LibraryRequestError(404, error.message);
    }
    throw error;
  }
}

/**
 * A stale backup set is the one undo failure that is the user's state rather
 * than a fault, so it has to stay a 404 across the protocol boundary. The
 * error class does not survive the frame, and the message is the wrong thing
 * to match on — rewording or localising it would silently turn every stale
 * undo into a 500.
 */
function isBackupMissingResponse(error: unknown): error is RuntimeRemoteError {
  return error instanceof RuntimeRemoteError && error.details?.kind === LIBRARY_BACKUP_MISSING_KIND;
}

/**
 * The winning bytes, from wherever they are.
 *
 * Local reads go straight to the filesystem the hub shares with its in-process
 * runtime — that is what every existing apply did, and routing it through the
 * protocol would change nothing except what can break. A remote winner is read
 * over the connection, contained by the location root on that machine.
 */
async function readSourceBytes(
  operation: PlannedOperation,
  userId: string,
  deps: PropagationApplyDeps
): Promise<Uint8Array> {
  if (operation.sourceEnvironmentId === LOCAL_ENVIRONMENT_ID) {
    return await deps.readSourceFile(operation.sourcePath);
  }
  const files = await deps.readRemoteSource(userId, operation.sourceEnvironmentId, {
    locationId: operation.sourceLocationId,
    path: operation.sourcePath,
  });
  const only = files[0];
  if (files.length !== 1 || !only) {
    throw new SourceReadError(
      `"${operation.resourceKey}" is a single file, but "${operation.sourceEnvironmentId}" answered with ${files.length}.`
    );
  }
  return only.contents;
}

/** The winning tree, read off the machine that holds it. */
async function readSourceTree(
  operation: PlannedOperation,
  userId: string,
  deps: PropagationApplyDeps
): Promise<readonly PreparedPropagationFile[]> {
  const files = await deps.readRemoteSource(userId, operation.sourceEnvironmentId, {
    locationId: operation.sourceLocationId,
    path: operation.sourcePath,
  });
  if (files.length === 0) {
    throw new SourceReadError(
      `"${operation.resourceKey}" has no files on "${operation.sourceEnvironmentId}", so there is nothing to copy.`
    );
  }
  return files;
}

class AdaptationError extends Error {}

/** The winning bytes could not be read off the machine that holds them. */
class SourceReadError extends Error {}

/**
 * Prefer curated copy for agent/provider failure codes so connector/provider
 * exception text never reaches PropagationFailure.message. Mechanical adapter
 * messages are already authored here and pass through unchanged.
 */
function clientFacingAdaptationMessage(error: {
  readonly code: string;
  readonly message: string;
}): string {
  switch (error.code) {
    case 'provider-failed':
      return 'The model provider failed during agent adaptation.';
    case 'adapter-timeout':
      return 'Agent adaptation timed out.';
    case 'adapter-cancelled':
      return 'Agent adaptation was cancelled.';
    default:
      return error.message;
  }
}

function describePrepareFailure(operation: PlannedOperation, error: unknown): PropagationFailure {
  const reason =
    error instanceof AdaptationError
      ? 'adaptation-failed'
      : error instanceof Error && error.name === 'LibraryWriteError'
        ? 'guard-rejected'
        : 'write-failed';
  return {
    resourceKey: operation.resourceKey,
    environmentId: operation.environmentId,
    locationId: operation.locationId,
    reason,
    message: error instanceof Error ? error.message : String(error),
  };
}

function validationError(message: string): LibraryRequestError {
  return new LibraryRequestError(422, message);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
