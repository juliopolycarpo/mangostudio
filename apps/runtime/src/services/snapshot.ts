import { unlink } from 'node:fs/promises';
import { RuntimeServiceError } from '../errors';
import {
  RUNTIME_ABSENT_HASH,
  type RuntimeBeforeSnapshot,
  type RuntimeMutationSnapshot,
  type RuntimeSnapshotRevertParams,
  type RuntimeSnapshotRevertResult,
} from '../methods';
import { forgetFile, recordFileRead, rekeyFile, withPathLocks } from './file-freshness';
import {
  assertRegularFilePath,
  isErrnoException,
  moveRegularFileWithoutOverwrite,
  writeRegularFileAtomic,
} from './fs-utils';

export class RuntimeSnapshotConflictError extends RuntimeServiceError {
  constructor(readonly resolvedPath: string) {
    super(
      'snapshot_conflict',
      `Cannot revert "${resolvedPath}": the file changed on disk since this assistant message completed.`,
      { resolvedPath }
    );
    this.name = 'RuntimeSnapshotConflictError';
  }
}

export class RuntimeSnapshotTooLargeError extends RuntimeServiceError {
  constructor(resolvedPath: string, sizeBytes: number) {
    super(
      'snapshot_too_large',
      `Cannot checkpoint "${resolvedPath}": it is ${sizeBytes} bytes, past the ` +
        `${RUNTIME_SNAPSHOT_MAX_BYTES}-byte snapshot limit.`,
      { resolvedPath, sizeBytes }
    );
    this.name = 'RuntimeSnapshotTooLargeError';
  }
}

/**
 * Largest file a checkpoint snapshot may carry. Base64 inflates the payload by
 * 4/3, so this leaves headroom under RUNTIME_MAX_FRAME_BYTES (16 MiB) for the
 * frame envelope and for the several mutations an apply_patch can return in one
 * response.
 */
export const RUNTIME_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Capturing runs before the mutation it protects, so rejecting an oversized file
 * here fails the tool while the filesystem is untouched. Encoding first and
 * letting the transport reject the frame would leave the mutation applied and
 * the checkpoint lost.
 */
export async function captureFileSnapshot(path: string): Promise<RuntimeBeforeSnapshot> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { exists: false };
  if (file.size > RUNTIME_SNAPSHOT_MAX_BYTES) {
    throw new RuntimeSnapshotTooLargeError(path, file.size);
  }
  return snapshotFromBytes(await file.bytes());
}

export function snapshotFromBytes(bytes: Uint8Array): RuntimeBeforeSnapshot {
  return {
    exists: true,
    contentBase64: Buffer.from(bytes).toString('base64'),
    hash: hashBytes(bytes),
  };
}

export async function hashFileAtPath(path: string): Promise<string | null> {
  if (!(await Bun.file(path).exists())) return null;
  return hashBytes(await Bun.file(path).bytes());
}

export function mutationSnapshot(
  captureSnapshot: boolean,
  input: {
    readonly path: string;
    readonly op: RuntimeMutationSnapshot['op'];
    readonly before: RuntimeBeforeSnapshot;
    readonly afterHash: string | null;
    readonly movedTo?: string;
  }
): readonly RuntimeMutationSnapshot[] {
  if (!captureSnapshot) return [];
  return [
    {
      path: input.path,
      op: input.op,
      ...(input.movedTo ? { movedTo: input.movedTo } : {}),
      before: input.before,
      afterHash: input.afterHash ?? RUNTIME_ABSENT_HASH,
    },
  ];
}

export async function revertRuntimeSnapshots(
  params: RuntimeSnapshotRevertParams
): Promise<RuntimeSnapshotRevertResult> {
  const paths = [
    ...params.expected.map((entry) => entry.path),
    ...params.operations.flatMap((operation) =>
      operation.type === 'move' ? [operation.path, operation.movedTo] : [operation.path]
    ),
  ];

  return await withPathLocks(paths, async () => {
    for (const entry of params.expected) {
      await assertMatchesAfterHash(entry.path, entry.afterHash);
    }

    for (const operation of params.operations) {
      switch (operation.type) {
        case 'create':
          await removeCreatedFile(operation.path);
          forgetFile(params.chatId, operation.path);
          break;
        case 'restore':
          await restoreBytes(params.chatId, operation.path, operation.contentBase64);
          break;
        case 'move': {
          const destination = await assertRegularFilePath(operation.movedTo, 'revert move');
          await moveRegularFileWithoutOverwrite(
            operation.movedTo,
            operation.path,
            destination.mode & 0o7777
          );
          rekeyFile(params.chatId, operation.movedTo, operation.path);
          await restoreBytes(params.chatId, operation.path, operation.contentBase64);
          break;
        }
      }
    }

    return {
      revertedFiles: new Set(params.operations.map((operation) => operation.path)).size,
    };
  });
}

async function assertMatchesAfterHash(path: string, expectedAfterHash: string): Promise<void> {
  const current = await hashFileAtPath(path);
  if (expectedAfterHash === RUNTIME_ABSENT_HASH) {
    if (current !== null) throw new RuntimeSnapshotConflictError(path);
    return;
  }
  if (current !== expectedAfterHash) throw new RuntimeSnapshotConflictError(path);
}

async function restoreBytes(chatId: string, path: string, contentBase64: string): Promise<void> {
  const bytes = decodeBase64(contentBase64);
  const committed = await writeRegularFileAtomic(path, bytes);
  recordFileRead(chatId, path, bytes, committed.mtimeMs);
}

async function removeCreatedFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return;
    throw error;
  }
}

function decodeBase64(content: string): Uint8Array {
  return Buffer.from(content, 'base64');
}

function hashBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}
