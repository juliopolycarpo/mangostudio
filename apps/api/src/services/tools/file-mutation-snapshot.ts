import type { RuntimeBeforeSnapshot, RuntimeMutationSnapshot } from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { FileCheckpointOp } from '@mangostudio/shared/file-checkpoints';
import { getDb } from '../../db/database';
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

type BeforeOmittedReason = 'binary' | 'too_large' | 'missing';

interface FileMutationBeforeFields {
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
 * Persists runtime-returned pre-mutation snapshots in execution order. Runtime
 * state remains disposable; checkpoint manifests and blobs stay hub-owned.
 */
export async function persistRuntimeMutations(
  context: ToolContext,
  mutations: readonly RuntimeMutationSnapshot[]
): Promise<readonly CapturedBefore[]> {
  if (mutations.length === 0) return [];
  if (!context.assistantMessageId) {
    return mutations.map(() => emptyCapturedBefore());
  }

  const paths = mutations.flatMap((mutation) =>
    mutation.movedTo ? [mutation.path, mutation.movedTo] : [mutation.path]
  );
  return await withPersistenceLocks(paths, async () => {
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
  });
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
      fields: beforeFieldsFromBytes(bytes),
    };
  }

  const { bytes, beforeHash } = decodeRuntimeSnapshot(mutation.before);
  const blobKey = bytes ? await storeCheckpointBlob(bytes) : null;
  const rowId = await insertCheckpointRow(db, {
    chatId: context.chatId,
    messageId,
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
    fields: beforeFieldsFromBytes(bytes),
  };
}

function decodeRuntimeSnapshot(snapshot: RuntimeBeforeSnapshot): {
  bytes: Uint8Array | null;
  beforeHash: string | null;
} {
  if (!snapshot.exists) return { bytes: null, beforeHash: null };
  if (!snapshot.contentBase64 || !snapshot.hash) {
    throw new Error('Runtime returned an incomplete file mutation snapshot.');
  }

  // The hash below is the integrity check. Re-encoding and comparing strings
  // would additionally demand canonical base64, which a non-Bun runtime behind a
  // byte transport is free not to emit (padding, line wrapping).
  const bytes = Buffer.from(snapshot.contentBase64, 'base64');
  const beforeHash = hashCheckpointBytes(bytes);
  if (beforeHash !== snapshot.hash) {
    throw new Error('Runtime file mutation snapshot hash did not match its bytes.');
  }
  return { bytes, beforeHash };
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
