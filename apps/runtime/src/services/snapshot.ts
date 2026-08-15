import { unlink } from 'node:fs/promises';
import { PathAccessError, RuntimeServiceError } from '../errors';
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
import { assertInsideWorkdir, WorkdirContainmentError } from './path-containment';

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

  if (params.containmentRoot) {
    for (const path of paths) {
      try {
        assertInsideWorkdir(params.containmentRoot, path);
      } catch (error) {
        if (error instanceof PathAccessError) throw error;
        if (error instanceof WorkdirContainmentError) {
          throw new PathAccessError(error.message);
        }
        const message =
          error instanceof Error ? error.message : 'Working directory is not accessible.';
        throw new PathAccessError(
          `Cannot resolve the chat working directory "${params.containmentRoot}": ${message}`
        );
      }
    }
  }

  const revertedFiles = new Set(params.operations.map((operation) => operation.path)).size;

  return await withPathLocks(paths, async () => {
    if (await alreadyReverted(params.expected)) {
      // The filesystem half of a previous call finished; only its caller's
      // bookkeeping did not. Replaying the operations from here would undo
      // rows against the wrong baseline, so report the work as done instead.
      return { revertedFiles };
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

    return { revertedFiles };
  });
}

/**
 * Decides whether these paths still hold what the message left behind, or
 * already hold what reverting it produces, and rejects anything else.
 *
 * The decision is taken for the set rather than per path: the operations are a
 * replay in reverse, so a path touched by several of them has intermediate
 * states that its final hash cannot distinguish. Resuming a half-applied replay
 * from the middle could delete a file an earlier operation had just restored,
 * which is why a genuinely mixed set is a conflict rather than a resume.
 */
async function alreadyReverted(
  expected: RuntimeSnapshotRevertParams['expected']
): Promise<boolean> {
  let pendingPath: string | null = null;
  let revertedPath: string | null = null;
  for (const entry of expected) {
    const observed = (await hashFileAtPath(entry.path)) ?? RUNTIME_ABSENT_HASH;
    const matchesAfter = observed === entry.afterHash;
    const matchesReverted = entry.revertedHash !== undefined && observed === entry.revertedHash;
    if (!matchesAfter && !matchesReverted) throw new RuntimeSnapshotConflictError(entry.path);
    // A path whose two states coincide matches both and settles nothing.
    if (matchesAfter && !matchesReverted) pendingPath ??= entry.path;
    else if (matchesReverted && !matchesAfter) revertedPath ??= entry.path;
  }
  // Name the path that is already reverted: it is the one whose state the
  // remaining operations cannot be replayed against.
  if (pendingPath !== null && revertedPath !== null) {
    throw new RuntimeSnapshotConflictError(revertedPath);
  }
  return revertedPath !== null;
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
