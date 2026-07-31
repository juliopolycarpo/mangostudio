import {
  RUNTIME_ABSENT_HASH,
  RuntimeSnapshotConflictError,
  type RuntimeSnapshotRevertParams,
} from '@mangostudio/runtime';
import type { Kysely } from 'kysely';
import type { Database, FileCheckpointSelect } from '../../../db/types';
import { getRuntimeClient } from '../../../services/runtime-client';
import { readCheckpointBlob } from '../infrastructure/checkpoint-blob-store';
import {
  listActiveCheckpointsForMessage,
  markMessageCheckpointsReverted,
} from '../infrastructure/checkpoint-repository';

export class FileCheckpointConflictError extends Error {
  constructor(readonly resolvedPath: string) {
    super(
      `Cannot revert "${resolvedPath}": the file changed on disk since this assistant message completed.`
    );
    this.name = 'FileCheckpointConflictError';
  }
}

export async function revertMessageFileCheckpoints(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<{ revertedFiles: number }> {
  const rows = await listActiveCheckpointsForMessage(db, chatId, messageId);
  if (rows.length === 0) return { revertedFiles: 0 };

  const operations = await buildRevertOperations(rows);
  const expected = [...finalStateByPath(rows)].map(([path, afterHash]) => ({
    path,
    afterHash,
  }));
  const runtime = await getRuntimeClient();
  let result: { revertedFiles: number };
  try {
    result = await runtime.snapshot.revert({ chatId, expected, operations });
  } catch (error) {
    if (error instanceof RuntimeSnapshotConflictError) {
      throw new FileCheckpointConflictError(error.resolvedPath);
    }
    throw error;
  }

  await markMessageCheckpointsReverted(db, chatId, messageId, Date.now());
  return result;
}

async function buildRevertOperations(
  rows: readonly FileCheckpointSelect[]
): Promise<RuntimeSnapshotRevertParams['operations']> {
  const operations: RuntimeSnapshotRevertParams['operations'][number][] = [];
  for (const row of [...rows].reverse()) {
    switch (row.op) {
      case 'create':
        operations.push({ type: 'create', path: row.path });
        break;
      case 'delete':
      case 'edit':
        operations.push({
          type: 'restore',
          path: row.path,
          contentBase64: await readRequiredBlob(row),
        });
        break;
      case 'move':
        if (!row.movedTo) throw new FileCheckpointConflictError(row.path);
        operations.push({
          type: 'move',
          path: row.path,
          movedTo: row.movedTo,
          contentBase64: await readRequiredBlob(row),
        });
        break;
      default:
        throw new Error(`Unknown checkpoint op: ${row.op}`);
    }
  }
  return operations;
}

async function readRequiredBlob(row: FileCheckpointSelect): Promise<string> {
  if (!row.blobKey) throw new FileCheckpointConflictError(row.path);
  const bytes = await readCheckpointBlob(row.blobKey);
  if (!bytes) throw new FileCheckpointConflictError(row.path);
  return Buffer.from(bytes).toString('base64');
}

/**
 * Replays the message's rows to derive what it left on disk, path by path. Only
 * these final states are safe to compare before reverting.
 */
function finalStateByPath(rows: readonly FileCheckpointSelect[]): Map<string, string> {
  const expected = new Map<string, string>();
  for (const row of rows) {
    const afterHash = row.afterHash ?? RUNTIME_ABSENT_HASH;
    if (row.movedTo) {
      expected.set(row.path, RUNTIME_ABSENT_HASH);
      expected.set(row.movedTo, afterHash);
    } else {
      expected.set(row.path, afterHash);
    }
  }
  return expected;
}
