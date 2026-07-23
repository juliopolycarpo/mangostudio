import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { writeRegularFileAtomic } from '../../../lib/safe-file';
import { assertRegularFilePath } from '../../../services/tools/builtin/_fs-utils';
import { moveRegularFileWithoutOverwrite } from '../../../services/tools/builtin/move-file';
import { forgetFile, recordFileRead, rekeyFile } from '../../../services/tools/file-freshness';
import {
  assertAbsentOrMatchHash,
  FileCheckpointConflictError,
  hashFileAtPath,
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

  const reversed = [...rows].reverse();
  for (const row of reversed) {
    if (row.op === 'move' && row.movedTo) {
      await assertAbsentOrMatchHash(row.movedTo, row.afterHash);
    } else {
      await assertAbsentOrMatchHash(row.path, row.afterHash);
    }
  }

  for (const row of reversed) {
    switch (row.op) {
      case 'create':
        await unlink(row.path).catch(() => undefined);
        forgetFile(chatId, row.path);
        break;
      case 'delete': {
        if (!row.blobKey) throw new FileCheckpointConflictError(row.path);
        const bytes = await readCheckpointBlob(row.blobKey);
        if (!bytes) throw new FileCheckpointConflictError(row.path);
        await mkdir(dirname(row.path), { recursive: true });
        const committed = await writeRegularFileAtomic(row.path, bytes);
        recordFileRead(chatId, row.path, bytes, committed.mtimeMs);
        break;
      }
      case 'edit': {
        if (!row.blobKey) throw new FileCheckpointConflictError(row.path);
        const bytes = await readCheckpointBlob(row.blobKey);
        if (!bytes) throw new FileCheckpointConflictError(row.path);
        const committed = await writeRegularFileAtomic(row.path, bytes);
        recordFileRead(chatId, row.path, bytes, committed.mtimeMs);
        break;
      }
      case 'move': {
        if (!row.movedTo) throw new FileCheckpointConflictError(row.path);
        const dest = row.movedTo;
        const entry = await assertRegularFilePath(dest, 'revert move');
        await moveRegularFileWithoutOverwrite(dest, row.path, entry.mode & 0o7777);
        rekeyFile(chatId, dest, row.path);
        const hash = await hashFileAtPath(row.path);
        if (hash) recordFileRead(chatId, row.path, await Bun.file(row.path).bytes(), Date.now());
        break;
      }
      default:
        throw new Error(`Unknown checkpoint op: ${row.op}`);
    }
  }

  await markMessageCheckpointsReverted(db, chatId, messageId, Date.now());
  return { revertedFiles: rows.length };
}
