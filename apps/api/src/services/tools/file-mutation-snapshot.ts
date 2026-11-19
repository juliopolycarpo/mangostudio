import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { FileCheckpointOp } from '@mangostudio/shared/file-checkpoints';
import {
  type RuntimeBeforeSnapshot,
  type RuntimeMutationResult,
  type RuntimeMutationSnapshot,
  SNAPSHOT_CHUNK_MAX_BYTES,
  SNAPSHOT_HARD_MAX_BYTES,
} from '@mangostudio/shared/runtime-contract';

import { getDb } from '../../db/database';
import { getConfig } from '../../lib/config';
import { createDiagnosticLogger } from '../../lib/logger';
import {
  messageStagedUsage,
  stagedCaptureLimit,
} from '../../modules/file-checkpoints/application/staged-capture-limit';
import {
  checkpointBlobExists,
  CheckpointBlobHashMismatchError,
  checkpointBlobSize,
  hashCheckpointBytes,
  readCheckpointBlob,
  storeCheckpointBlob,
  storeCheckpointBlobStream,
} from '../../modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import {
  enforceChatRetention,
  findCheckpointRow,
  insertCheckpointRow,
  updateCheckpointAfterHash,
} from '../../modules/file-checkpoints/infrastructure/checkpoint-repository';
import { scheduleGitFileMutationInvalidation } from '../../modules/git/application/git-realtime-service';
import { getRuntimeClient, runtimeStagesSnapshots } from '../runtime-client';
import type { ToolContext } from './types';

const BINARY_SNIFF_BYTES = 8192;
const BEFORE_MAX_BYTES = 128 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const persistenceLockTails = new Map<string, Promise<void>>();
const logger = createDiagnosticLogger('file-checkpoints');

/**
 * Why the pre-mutation content is not being shown back to the model.
 * `corrupt` means the runtime's snapshot failed its own integrity check, so the
 * mutation is recorded but nothing was stored to restore from.
 */
export type BeforeOmittedReason = 'binary' | 'too_large' | 'missing' | 'corrupt';

export interface FileMutationBeforeFields {
  before?: string;
  beforeOmitted?: BeforeOmittedReason;
}

export interface CapturedBefore {
  readonly rowId: number | null;
  readonly beforeHash: string | null;
  readonly blobKey: string | null;
  readonly fields: FileMutationBeforeFields;
}

/**
 * The checkpoint half of a runtime mutation request: whether to snapshot, and
 * the largest file the user lets a checkpoint hold. A file past the limit makes
 * the runtime refuse the mutation before it changes anything, so no edit lands
 * that undo could not reverse.
 *
 * The limit is sent only to a runtime that advertises the staging methods. One
 * that predates them keeps its own inline ceiling (8 MiB) and never sees the
 * field, so a remote runtime running an older release behaves as it did before.
 *
 * The limit also shrinks as the message fills its staged-checkpoint budget (see
 * {@link stagedCaptureLimit}), so everything a message captures can still be
 * reverted in one call.
 *
 * // Usage: runtime.fs.writeFile({ ...params, ...(await snapshotCaptureParams(context)) })
 */
export async function snapshotCaptureParams(context: ToolContext): Promise<{
  captureSnapshot: boolean;
  snapshotMaxBytes?: number;
}> {
  const messageId = context.assistantMessageId;
  if (!messageId) return { captureSnapshot: false };
  if (!(await runtimeStagesSnapshots(context.userId, context.environmentId))) {
    return { captureSnapshot: true };
  }
  const used = await messageStagedUsage(context.db ?? getDb(), context.chatId, messageId);
  return {
    captureSnapshot: true,
    snapshotMaxBytes: stagedCaptureLimit(getConfig().checkpoints.maxFileBytes, used),
  };
}

/**
 * Runs a runtime mutation and persists its checkpoint under one set of per-path
 * locks, so a second call on the same path cannot start its own mutation in the
 * gap between them. Without that, two mutations of one path can persist in the
 * opposite order and leave a row pairing one call's `before` with the other's
 * `afterHash` — a state matching neither the disk nor any point in the file's
 * history.
 *
 * `paths` must cover every path the mutation can touch; the hub resolves them
 * all before it dispatches, including the full operation set of an
 * `apply_patch`. Both this lock set and the runtime's own acquire in sorted
 * order, so nesting them is deadlock-free.
 *
 * The lock serializes mutation and persist. It does not undo the filesystem
 * write if blob or database I/O then fails, so that path still reports a tool
 * failure for a mutation that already landed and has no row to revert.
 *
 * // Usage: await withMutationPersistence(context, [resolvedPath], () => runtime.fs.editFile(params))
 */
export async function withMutationPersistence<T>(
  context: ToolContext,
  paths: readonly string[],
  mutate: () => Promise<RuntimeMutationResult<T>>
): Promise<{ result: T; captured: readonly CapturedBefore[] }> {
  if (!context.assistantMessageId) {
    const { result, mutations } = await mutate();
    return { result, captured: mutations.map(() => emptyCapturedBefore()) };
  }

  return await withPersistenceLocks(paths, async () => {
    const { result, mutations } = await mutate();
    return { result, captured: await persistLockedMutations(context, mutations) };
  });
}

/**
 * Persists runtime-returned pre-mutation snapshots in execution order. Runtime
 * state remains disposable; checkpoint manifests and blobs stay hub-owned. The
 * caller must already hold the persistence lock for every path involved.
 */
async function persistLockedMutations(
  context: ToolContext,
  mutations: readonly RuntimeMutationSnapshot[]
): Promise<readonly CapturedBefore[]> {
  if (mutations.length === 0) return [];

  const captured: CapturedBefore[] = [];
  try {
    for (const mutation of mutations) {
      captured.push(await persistRuntimeMutation(context, mutation));
    }
  } finally {
    // A persist that threw leaves the staged copies of the mutations after it
    // on the runtime; free them now rather than waiting for its sweep.
    await releaseStagedBefores(context, mutations.slice(captured.length));
  }
  scheduleGitFileMutationInvalidation({
    userId: context.userId,
    chatId: context.chatId,
    environmentId: context.environmentId ?? LOCAL_ENVIRONMENT_ID,
  });
  return captured;
}

async function persistRuntimeMutation(
  context: ToolContext,
  mutation: RuntimeMutationSnapshot
): Promise<CapturedBefore> {
  const messageId = context.assistantMessageId;
  if (!messageId) return emptyCapturedBefore();
  try {
    return await persistCheckpointRow(context, messageId, mutation);
  } finally {
    // Whether the staged copy was pulled, skipped (a later mutation of the same
    // path collapses onto the first row) or failed, the runtime can drop it now.
    await releaseStagedBefores(context, [mutation]);
  }
}

async function persistCheckpointRow(
  context: ToolContext,
  messageId: string,
  mutation: RuntimeMutationSnapshot
): Promise<CapturedBefore> {
  const db = context.db ?? getDb();

  const existing =
    mutation.op === 'move'
      ? undefined
      : await findCheckpointRow(db, context.chatId, messageId, mutation.path);
  if (existing) {
    await updateCheckpointAfterHash(db, existing.id, mutation.afterHash);
    return {
      rowId: existing.id,
      beforeHash: existing.beforeHash,
      blobKey: existing.blobKey,
      fields: await beforeFieldsFromRow(existing),
    };
  }

  const stored = await storeRuntimeBefore(context, mutation.before);
  if (!stored.ok) {
    logger.error('checkpoint_snapshot_integrity_violation', {
      chatId: context.chatId,
      messageId,
      path: mutation.path,
      op: mutation.op,
      reason: stored.reason,
      expectedHash: stored.expectedHash,
      observedHash: stored.observedHash,
      ...(stored.cause === undefined ? {} : { cause: stored.cause }),
    });
  }
  const beforeHash = stored.ok ? stored.beforeHash : null;
  const blobKey = stored.ok ? stored.blobKey : null;
  const rowId = await insertCheckpointRow(db, {
    chatId: context.chatId,
    messageId,
    environmentId: context.environmentId ?? LOCAL_ENVIRONMENT_ID,
    path: mutation.path,
    op: mutation.op satisfies FileCheckpointOp,
    beforeHash,
    afterHash: mutation.afterHash,
    movedTo: mutation.movedTo ?? null,
    blobKey,
  });
  await enforceChatRetention(db, context.chatId);
  return {
    rowId,
    beforeHash,
    blobKey,
    fields: stored.ok ? stored.fields : { beforeOmitted: 'corrupt' },
  };
}

type StoredBefore =
  | {
      readonly ok: true;
      readonly beforeHash: string | null;
      readonly blobKey: string | null;
      readonly fields: FileMutationBeforeFields;
    }
  | {
      readonly ok: false;
      readonly reason: 'incomplete' | 'hash_mismatch' | 'transfer_failed';
      readonly expectedHash: string | null;
      readonly observedHash: string | null;
      readonly cause?: string;
    };

/**
 * Stores what the runtime captured before a mutation: inline bytes straight
 * from the response, or a staged capture pulled chunk by chunk into the blob
 * store so a large file never sits in memory.
 *
 * Reports rather than throws: the mutation it describes has already been
 * applied to disk, so failing here would report a failure for a write that
 * succeeded and invite the model to apply it a second time. The caller records
 * the row with a degraded before-state instead, which keeps the revert
 * affordance honest about what it cannot restore.
 */
async function storeRuntimeBefore(
  context: ToolContext,
  snapshot: RuntimeBeforeSnapshot
): Promise<StoredBefore> {
  if (!snapshot.exists) {
    return { ok: true, beforeHash: null, blobKey: null, fields: { beforeOmitted: 'missing' } };
  }
  if (snapshot.stagedId !== undefined) return await storeStagedBefore(context, snapshot);

  const decoded = decodeInlineSnapshot(snapshot);
  if (!decoded.ok) return decoded;
  const blobKey = await storeCheckpointBlob(decoded.bytes);
  return {
    ok: true,
    beforeHash: decoded.beforeHash,
    blobKey,
    fields: beforeFieldsFromBytes(decoded.bytes),
  };
}

async function storeStagedBefore(
  context: ToolContext,
  snapshot: RuntimeBeforeSnapshot
): Promise<StoredBefore> {
  const { stagedId, hash } = snapshot;
  if (stagedId === undefined || typeof hash !== 'string') {
    return { ok: false, reason: 'incomplete', expectedHash: hash ?? null, observedHash: null };
  }
  try {
    const runtime = await getRuntimeClient(context.userId, context.environmentId);
    const { blobKey } = await storeCheckpointBlobStream(
      pullStagedChunks(
        runtime,
        stagedId,
        snapshot.sizeBytes,
        // The runtime clamps what it stages to the hard maximum, whatever was configured.
        Math.min(getConfig().checkpoints.maxFileBytes, SNAPSHOT_HARD_MAX_BYTES)
      ),
      hash
    );
    return {
      ok: true,
      beforeHash: blobKey,
      blobKey,
      // A staged capture is past the inline size, which is past what the tool
      // result shows back to the model.
      fields: { beforeOmitted: 'too_large' },
    };
  } catch (error) {
    if (error instanceof CheckpointBlobHashMismatchError) {
      return {
        ok: false,
        reason: 'hash_mismatch',
        expectedHash: error.expectedHash,
        observedHash: error.observedHash,
      };
    }
    return {
      ok: false,
      reason: 'transfer_failed',
      expectedHash: hash,
      observedHash: null,
      cause: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The one runtime method a staged pull uses. */
export interface StagedChunkSource {
  readonly snapshot: {
    readonly readChunk: (params: {
      stagedId: string;
      offset: number;
      length: number;
    }) => Promise<{ contentBase64: string }>;
  };
}

/**
 * Reads a staged capture as consecutive bounded slices, until its end.
 *
 * The runtime is trusted to stage what it reports, not to stay inside the
 * bounds: the pull ends at `min(sizeBytes, maxBytes)` whatever the runtime
 * keeps returning, asks for no more than is left of that, and refuses a chunk
 * longer than it asked for, so a faulty or hostile peer cannot make the hub
 * write more than the checkpoint limit to disk. A chunk that comes back empty
 * before the reported size is reached is a truncated capture and an error,
 * where treating it as the end would only surface later as a hash mismatch.
 *
 * // Usage: storeCheckpointBlobStream(pullStagedChunks(runtime, stagedId, sizeBytes, limit), hash)
 */
export async function* pullStagedChunks(
  runtime: StagedChunkSource,
  stagedId: string,
  sizeBytes: number | undefined,
  maxBytes: number
): AsyncGenerator<Uint8Array> {
  if (sizeBytes !== undefined && sizeBytes > maxBytes) {
    throw new Error(
      `staged capture ${stagedId} reports ${sizeBytes} bytes, past the ${maxBytes}-byte checkpoint limit`
    );
  }
  const total = sizeBytes ?? maxBytes;
  let offset = 0;
  while (offset < total) {
    const length = Math.min(SNAPSHOT_CHUNK_MAX_BYTES, total - offset);
    const { contentBase64 } = await runtime.snapshot.readChunk({ stagedId, offset, length });
    const chunk = Buffer.from(contentBase64, 'base64');
    if (chunk.byteLength > length) {
      throw new Error(
        `staged capture ${stagedId} returned ${chunk.byteLength} bytes at offset ${offset}, ` +
          `but ${length} were requested`
      );
    }
    if (chunk.byteLength === 0) {
      if (sizeBytes === undefined) return;
      throw new Error(
        `staged capture ${stagedId} ended at offset ${offset}, before its reported ${sizeBytes} bytes`
      );
    }
    yield chunk;
    offset += chunk.byteLength;
  }
}

/** Drops the runtime-side copies of staged captures; a failure only delays the runtime's own sweep. */
async function releaseStagedBefores(
  context: ToolContext,
  mutations: readonly RuntimeMutationSnapshot[]
): Promise<void> {
  const stagedIds = mutations.flatMap((mutation) =>
    mutation.before.stagedId === undefined ? [] : [mutation.before.stagedId]
  );
  if (stagedIds.length === 0) return;
  try {
    const runtime = await getRuntimeClient(context.userId, context.environmentId);
    await Promise.all(
      stagedIds.map((stagedId) => runtime.snapshot.release({ stagedId }).catch(() => undefined))
    );
  } catch {
    // The runtime expires an unreleased capture on its own.
  }
}

type InlineSnapshot =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly beforeHash: string }
  | {
      readonly ok: false;
      readonly reason: 'incomplete' | 'hash_mismatch';
      readonly expectedHash: string | null;
      readonly observedHash: string | null;
    };

/** Decodes a `before` that carries its bytes in the response and checks them against its hash. */
function decodeInlineSnapshot(snapshot: RuntimeBeforeSnapshot): InlineSnapshot {
  // Empty content is a complete snapshot (`contentBase64: ''` plus the SHA-256
  // of zero bytes). A truthy check would classify that as incomplete and drop
  // the only copy we could restore from.
  if (typeof snapshot.contentBase64 !== 'string' || typeof snapshot.hash !== 'string') {
    return {
      ok: false,
      reason: 'incomplete',
      expectedHash: snapshot.hash ?? null,
      observedHash: null,
    };
  }

  // The hash below is the integrity check. Re-encoding and comparing strings
  // would additionally demand canonical base64, which a non-Bun runtime behind a
  // byte transport is free not to emit (padding, line wrapping).
  const bytes = Buffer.from(snapshot.contentBase64, 'base64');
  const beforeHash = hashCheckpointBytes(bytes);
  if (beforeHash !== snapshot.hash) {
    return {
      ok: false,
      reason: 'hash_mismatch',
      expectedHash: snapshot.hash,
      observedHash: beforeHash,
    };
  }
  return { ok: true, bytes, beforeHash };
}

export function attachBeforeFields<T extends object>(
  result: T,
  captured: CapturedBefore | undefined
): T & FileMutationBeforeFields {
  return { ...result, ...(captured?.fields ?? {}) };
}

function emptyCapturedBefore(): CapturedBefore {
  return { rowId: null, beforeHash: null, blobKey: null, fields: {} };
}

function beforeFieldsFromBytes(bytes: Uint8Array | null): FileMutationBeforeFields {
  if (bytes === null) return { beforeOmitted: 'missing' };
  if (bytes.byteLength > BEFORE_MAX_BYTES) return { beforeOmitted: 'too_large' };
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { beforeOmitted: 'binary' };
  }
  try {
    return { before: textDecoder.decode(bytes) };
  } catch {
    return { beforeOmitted: 'binary' };
  }
}

/**
 * Rebuilds the tool-result before-fields from the row a later mutation of the
 * same path collapsed onto. Bytes reconstruct binary / too-large / text; the
 * stored size alone answers "too large", so a big blob is never loaded to be
 * described. A non-create row that stored neither a blob nor a hash is the
 * degraded insert (`corrupt`); a create with nothing on disk is `missing`.
 */
async function beforeFieldsFromRow(row: {
  op: string;
  beforeHash: string | null;
  blobKey: string | null;
}): Promise<FileMutationBeforeFields> {
  if (row.blobKey !== null && (await checkpointBlobExists(row.blobKey))) {
    if (checkpointBlobSize(row.blobKey) > BEFORE_MAX_BYTES) return { beforeOmitted: 'too_large' };
    const bytes = await readCheckpointBlob(row.blobKey);
    if (bytes !== null) return beforeFieldsFromBytes(bytes);
  }
  if (row.op !== 'create' && row.blobKey === null && row.beforeHash === null) {
    return { beforeOmitted: 'corrupt' };
  }
  return { beforeOmitted: 'missing' };
}

async function withPersistenceLocks<T>(
  paths: readonly string[],
  execute: () => Promise<T>
): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const path of [...new Set(paths)].sort()) {
      releases.push(await acquirePersistenceLock(path));
    }
    return await execute();
  } finally {
    for (let index = releases.length - 1; index >= 0; index--) releases[index]?.();
  }
}

async function acquirePersistenceLock(path: string): Promise<() => void> {
  const previous = persistenceLockTails.get(path) ?? Promise.resolve();
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  persistenceLockTails.set(path, tail);
  await previous;
  return () => {
    releaseGate();
    if (persistenceLockTails.get(path) === tail) persistenceLockTails.delete(path);
  };
}
