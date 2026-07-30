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
import { containsNulByte } from './builtin/_fs-utils';
import type { ToolContext } from './types';

const BINARY_SNIFF_BYTES = 8192;
/**
 * `before` travels back to the model inside the tool result and is replayed with
 * every later turn, so it is capped far below read_file's ceiling. Past it the
 * preview falls back to the argument-only rendering.
 */
const BEFORE_MAX_BYTES = 128 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * `afterHash` for a path the mutation left absent. A NULL `afterHash` means the
 * tool threw before finishing, so the row describes no completed mutation and is
 * excluded from the revertable set.
 */
export const CHECKPOINT_ABSENT_HASH = 'absent';

type BeforeOmittedReason = 'binary' | 'too_large' | 'missing';

interface FileMutationBeforeFields {
  before?: string;
  beforeOmitted?: BeforeOmittedReason;
}

export interface CapturedBefore {
  /** Manifest row to complete, or null when this context does not checkpoint. */
  readonly rowId: number | null;
  readonly bytes: Uint8Array | null;
  readonly beforeHash: string | null;
  readonly blobKey: string | null;
  readonly fields: FileMutationBeforeFields;
}

/**
 * Records the pre-mutation snapshot for a path on the first touch in an assistant
 * message. No-op when `assistantMessageId` is absent (e.g. direct tool tests).
 */
export async function ensureFileMutationCheckpoint(
  context: ToolContext,
  resolvedPath: string,
  op: FileCheckpointOp,
  options?: { movedTo?: string }
): Promise<CapturedBefore> {
  if (!context.assistantMessageId) {
    return { rowId: null, bytes: null, beforeHash: null, blobKey: null, fields: {} };
  }

  const db = context.db ?? getDb();
  // A move hands its source path back, so `existing` is only reused while the
  // snapshot still describes what sits at `resolvedPath`.
  const existing =
    options?.movedTo === undefined
      ? await findCheckpointRow(db, context.chatId, context.assistantMessageId, resolvedPath)
      : undefined;
  if (existing) {
    const bytes = existing.blobKey !== null ? await readCheckpointBlob(existing.blobKey) : null;
    return {
      rowId: existing.id,
      bytes,
      beforeHash: existing.beforeHash,
      blobKey: existing.blobKey,
      fields: beforeFieldsFromBytes(bytes),
    };
  }

  const exists = await Bun.file(resolvedPath).exists();
  let beforeBytes: Uint8Array | null = null;
  let beforeHash: string | null = null;
  let blobKey: string | null = null;

  if (exists) {
    beforeBytes = await Bun.file(resolvedPath).bytes();
    beforeHash = hashCheckpointBytes(beforeBytes);
    blobKey = await storeCheckpointBlob(beforeBytes);
  }

  const rowId = await insertCheckpointRow(db, {
    chatId: context.chatId,
    messageId: context.assistantMessageId,
    path: resolvedPath,
    op,
    beforeHash,
    afterHash: null,
    movedTo: options?.movedTo ?? null,
    blobKey,
  });

  await enforceChatRetention(db, context.chatId);

  return {
    rowId,
    bytes: beforeBytes,
    beforeHash,
    blobKey,
    fields: beforeFieldsFromBytes(beforeBytes),
  };
}

/**
 * Completes the manifest row the matching `ensureFileMutationCheckpoint` opened,
 * which is also what marks it as describing a finished mutation. Pass `null` when
 * the path is absent afterwards. Keyed on the row rather than the path: a move
 * leaves its content somewhere else entirely.
 */
export async function recordFileMutationAfterHash(
  context: ToolContext,
  captured: CapturedBefore,
  afterHash: string | null
): Promise<void> {
  if (captured.rowId === null) return;
  const db = context.db ?? getDb();
  await updateCheckpointAfterHash(db, captured.rowId, afterHash ?? CHECKPOINT_ABSENT_HASH);
  scheduleGitFileMutationInvalidation({ userId: context.userId, chatId: context.chatId });
}

export function attachBeforeFields<T extends object>(
  result: T,
  captured: CapturedBefore
): T & FileMutationBeforeFields {
  return { ...result, ...captured.fields };
}

function beforeFieldsFromBytes(bytes: Uint8Array | null): FileMutationBeforeFields {
  if (bytes === null) return { beforeOmitted: 'missing' };
  if (bytes.byteLength > BEFORE_MAX_BYTES) return { beforeOmitted: 'too_large' };
  if (containsNulByte(bytes, Math.min(bytes.byteLength, BINARY_SNIFF_BYTES))) {
    return { beforeOmitted: 'binary' };
  }
  try {
    return { before: textDecoder.decode(bytes) };
  } catch {
    return { beforeOmitted: 'binary' };
  }
}

/** Hash of file at path, or null when the path does not exist. */
export async function hashFileAtPath(resolvedPath: string): Promise<string | null> {
  if (!(await Bun.file(resolvedPath).exists())) return null;
  return hashCheckpointBytes(await Bun.file(resolvedPath).bytes());
}

/** Verifies a path still holds the content the recorded mutation left behind. */
export async function assertMatchesAfterHash(
  resolvedPath: string,
  expectedAfterHash: string
): Promise<void> {
  const current = await hashFileAtPath(resolvedPath);
  if (expectedAfterHash === CHECKPOINT_ABSENT_HASH) {
    if (current !== null) throw new FileCheckpointConflictError(resolvedPath);
    return;
  }
  if (current !== expectedAfterHash) throw new FileCheckpointConflictError(resolvedPath);
}

export class FileCheckpointConflictError extends Error {
  constructor(readonly resolvedPath: string) {
    super(
      `Cannot revert "${resolvedPath}": the file changed on disk since this assistant message completed.`
    );
    this.name = 'FileCheckpointConflictError';
  }
}
