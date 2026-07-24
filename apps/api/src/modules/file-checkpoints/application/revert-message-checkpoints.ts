import { unlink } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import type { Database, FileCheckpointSelect } from '../../../db/types';
import { writeRegularFileAtomic } from '../../../lib/safe-file';
import { assertRegularFilePath, isErrnoException } from '../../../services/tools/builtin/_fs-utils';
import { moveRegularFileWithoutOverwrite } from '../../../services/tools/builtin/move-file';
import {
  forgetFile,
  recordFileRead,
  rekeyFile,
  withPathLocks,
} from '../../../services/tools/file-freshness';
import {
  assertMatchesAfterHash,
  CHECKPOINT_ABSENT_HASH,
  FileCheckpointConflictError,
} from '../../../services/tools/file-mutation-snapshot';
import { readCheckpointBlob } from '../infrastructure/checkpoint-blob-store';
import {
  listActiveCheckpointsForMessage,
  markMessageCheckpointsReverted,
} from '../infrastructure/checkpoint-repository';

export { FileCheckpointConflictError };

export async function revertMessageFileCheckpoints(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<{ revertedFiles: number }> {
  const rows = await listActiveCheckpointsForMessage(db, chatId, messageId);
  if (rows.length === 0) return { revertedFiles: 0 };

  // Same lock the mutation tools take, so a revert cannot interleave with a tool
  // call still writing the same paths.
  const lockedPaths = rows.flatMap((row) => (row.movedTo ? [row.path, row.movedTo] : [row.path]));
  return await withPathLocks(lockedPaths, async () => {
    for (const [path, expected] of finalStateByPath(rows)) {
      await assertMatchesAfterHash(path, expected);
    }

    for (const row of [...rows].reverse()) {
      switch (row.op) {
        case 'create':
          await removeCreatedFile(row.path);
          forgetFile(chatId, row.path);
          break;
        case 'delete':
        case 'edit':
          await restoreBlob(chatId, row.path, row.blobKey);
          break;
        case 'move': {
          if (!row.movedTo) throw new FileCheckpointConflictError(row.path);
          const dest = row.movedTo;
          const entry = await assertRegularFilePath(dest, 'revert move');
          await moveRegularFileWithoutOverwrite(dest, row.path, entry.mode & 0o7777);
          rekeyFile(chatId, dest, row.path);
          // A patch may have moved and rewritten the file in one operation, so
          // the rename alone does not restore the recorded content.
          await restoreBlob(chatId, row.path, row.blobKey);
          break;
        }
        default:
          throw new Error(`Unknown checkpoint op: ${row.op}`);
      }
    }

    await markMessageCheckpointsReverted(db, chatId, messageId, Date.now());
    // Distinct paths, not rows: one file mutated twice in a turn is one revert.
    return { revertedFiles: new Set(rows.map((row) => row.path)).size };
  });
}

/**
 * Replays the message's rows to derive what it left on disk, path by path. Only
 * these end states are verifiable: a path the message touched more than once
 * holds the last row's content, and a move leaves its source empty. Checking
 * every row's `afterHash` instead would reject a path that a later row in the
 * same message legitimately overwrote or emptied.
 */
function finalStateByPath(rows: readonly FileCheckpointSelect[]): Map<string, string> {
  const expected = new Map<string, string>();
  for (const row of rows) {
    // Never null for a revertable row: the repository filters out rows whose
    // tool threw before it recorded the post-mutation state.
    const afterHash = row.afterHash ?? CHECKPOINT_ABSENT_HASH;
    if (row.movedTo) {
      expected.set(row.path, CHECKPOINT_ABSENT_HASH);
      expected.set(row.movedTo, afterHash);
    } else {
      expected.set(row.path, afterHash);
    }
  }
  return expected;
}

/** Restores a path to its snapshot, refreshing the chat's freshness entry. */
async function restoreBlob(
  chatId: string,
  resolvedPath: string,
  blobKey: string | null
): Promise<void> {
  if (!blobKey) throw new FileCheckpointConflictError(resolvedPath);
  const bytes = await readCheckpointBlob(blobKey);
  if (!bytes) throw new FileCheckpointConflictError(resolvedPath);
  const committed = await writeRegularFileAtomic(resolvedPath, bytes);
  recordFileRead(chatId, resolvedPath, bytes, committed.mtimeMs);
}

/** Undoes a creation. Only an already-absent path counts as success. */
async function removeCreatedFile(resolvedPath: string): Promise<void> {
  try {
    await unlink(resolvedPath);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return;
    throw error;
  }
}
