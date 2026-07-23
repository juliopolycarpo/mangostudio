import type { Kysely } from 'kysely';
import { getDb } from '../../db/database';
import type { Database } from '../../db/types';
import { storeCheckpointBlob } from '../../modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import {
  enforceChatRetention,
  type FileCheckpointOp,
  findCheckpointRow,
  insertCheckpointRow,
  updateCheckpointAfterHash,
} from '../../modules/file-checkpoints/infrastructure/checkpoint-repository';
import { containsNulByte, READ_FILE_MAX_BYTES } from './builtin/_fs-utils';
import type { ToolContext } from './types';

const BINARY_SNIFF_BYTES = 8192;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

type BeforeOmittedReason = 'binary' | 'too_large' | 'missing';

interface FileMutationBeforeFields {
  before?: string;
  beforeOmitted?: BeforeOmittedReason;
}

interface CapturedBefore {
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
    return { bytes: null, beforeHash: null, blobKey: null, fields: {} };
  }

  const db = context.db ?? getDb();
  const existing = await findCheckpointRow(
    db,
    context.chatId,
    context.assistantMessageId,
    resolvedPath
  );
  if (existing) {
    const bytes = existing.blobKey !== null ? await readBlobForRow(db, existing.blobKey) : null;
    return {
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
    beforeHash = hashBytes(beforeBytes);
    blobKey = await storeCheckpointBlob(beforeBytes);
  }

  await insertCheckpointRow(db, {
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
    bytes: beforeBytes,
    beforeHash,
    blobKey,
    fields: beforeFieldsFromBytes(beforeBytes),
  };
}

/** Persists the post-mutation content hash for a manifest row. */
export async function recordFileMutationAfterHash(
  context: ToolContext,
  resolvedPath: string,
  afterHash: string | null
): Promise<void> {
  if (!context.assistantMessageId) return;
  const db = context.db ?? getDb();
  const row = await findCheckpointRow(db, context.chatId, context.assistantMessageId, resolvedPath);
  if (!row) return;
  await updateCheckpointAfterHash(db, row.id, afterHash);
}

export function attachBeforeFields<T extends object>(
  result: T,
  captured: CapturedBefore
): T & FileMutationBeforeFields {
  return { ...result, ...captured.fields };
}

function beforeFieldsFromBytes(bytes: Uint8Array | null): FileMutationBeforeFields {
  if (bytes === null) return { beforeOmitted: 'missing' };
  if (bytes.byteLength > READ_FILE_MAX_BYTES) return { beforeOmitted: 'too_large' };
  if (containsNulByte(bytes, Math.min(bytes.byteLength, BINARY_SNIFF_BYTES))) {
    return { beforeOmitted: 'binary' };
  }
  try {
    return { before: textDecoder.decode(bytes) };
  } catch {
    return { beforeOmitted: 'binary' };
  }
}

function hashBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

async function readBlobForRow(_db: Kysely<Database>, blobKey: string): Promise<Uint8Array | null> {
  const { readCheckpointBlob } = await import(
    '../../modules/file-checkpoints/infrastructure/checkpoint-blob-store'
  );
  return readCheckpointBlob(blobKey);
}

/** Hash of file at path, or null when the path does not exist. */
export async function hashFileAtPath(resolvedPath: string): Promise<string | null> {
  if (!(await Bun.file(resolvedPath).exists())) return null;
  const bytes = await Bun.file(resolvedPath).bytes();
  return hashBytes(bytes);
}

/** Hash after delete: file must be absent. */
export async function assertAbsentOrMatchHash(
  resolvedPath: string,
  expectedAfterHash: string | null
): Promise<void> {
  const current = await hashFileAtPath(resolvedPath);
  if (expectedAfterHash === null) {
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
