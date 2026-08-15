import type {
  RuntimeBeforeSnapshot,
  RuntimeMutationResult,
  RuntimeMutationSnapshot,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { FileCheckpointOp } from '@mangostudio/shared/file-checkpoints';
import { getDb } from '../../db/database';
import { createDiagnosticLogger } from '../../lib/logger';
import {
  hashCheckpointBytes,
  readCheckpointBlob,
  storeCheckpointBlob,
} from '../../modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import {
  enforceChatRetention,
  findCheckpointRow,
  insertCheckpointRow,
  updateCheckpointAfterHash,
} from '../../modules/file-checkpoints/infrastructure/checkpoint-repository';
import { scheduleGitFileMutationInvalidation } from '../../modules/git/application/git-realtime-service';
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
  readonly bytes: Uint8Array | null;
  readonly beforeHash: string | null;
  readonly blobKey: string | null;
  readonly fields: FileMutationBeforeFields;
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
  for (const mutation of mutations) {
    captured.push(await persistRuntimeMutation(context, mutation));
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
  const db = context.db ?? getDb();

  const existing =
    mutation.op === 'move'
      ? undefined
      : await findCheckpointRow(db, context.chatId, messageId, mutation.path);
  if (existing) {
    const bytes = existing.blobKey ? await readCheckpointBlob(existing.blobKey) : null;
    await updateCheckpointAfterHash(db, existing.id, mutation.afterHash);
    return {
      rowId: existing.id,
      bytes,
      beforeHash: existing.beforeHash,
      blobKey: existing.blobKey,
      fields: beforeFieldsFromRow(existing, bytes),
    };
  }

  const decoded = decodeRuntimeSnapshot(mutation.before);
  if (!decoded.ok) {
    logger.error('checkpoint_snapshot_integrity_violation', {
      chatId: context.chatId,
      messageId,
      path: mutation.path,
      op: mutation.op,
      reason: decoded.reason,
      expectedHash: decoded.expectedHash,
      observedHash: decoded.observedHash,
    });
  }
  const bytes = decoded.ok ? decoded.bytes : null;
  const beforeHash = decoded.ok ? decoded.beforeHash : null;
  const blobKey = bytes !== null ? await storeCheckpointBlob(bytes) : null;
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
    bytes,
    beforeHash,
    blobKey,
    fields: decoded.ok ? beforeFieldsFromBytes(bytes) : { beforeOmitted: 'corrupt' },
  };
}

type DecodedSnapshot =
  | { readonly ok: true; readonly bytes: Uint8Array | null; readonly beforeHash: string | null }
  | {
      readonly ok: false;
      readonly reason: 'incomplete' | 'hash_mismatch';
      readonly expectedHash: string | null;
      readonly observedHash: string | null;
    };

/**
 * Reports rather than throws: the mutation it describes has already been
 * applied to disk, so failing here would report a failure for a write that
 * succeeded and invite the model to apply it a second time. The caller records
 * the row with a degraded before-state instead, which keeps the revert
 * affordance honest about what it cannot restore.
 */
function decodeRuntimeSnapshot(snapshot: RuntimeBeforeSnapshot): DecodedSnapshot {
  if (!snapshot.exists) return { ok: true, bytes: null, beforeHash: null };
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
  return { rowId: null, bytes: null, beforeHash: null, blobKey: null, fields: {} };
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
 * same path collapsed onto. Bytes reconstruct binary / too-large / text. A
 * non-create row that stored neither a blob nor a hash is the degraded insert
 * (`corrupt`); a create with nothing on disk is `missing`.
 */
function beforeFieldsFromRow(
  row: { op: string; beforeHash: string | null; blobKey: string | null },
  bytes: Uint8Array | null
): FileMutationBeforeFields {
  if (bytes !== null) return beforeFieldsFromBytes(bytes);
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
