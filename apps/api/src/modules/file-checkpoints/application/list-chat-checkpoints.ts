import type {
  ChatFileCheckpointSummary,
  FileCheckpointOp,
} from '@mangostudio/shared/file-checkpoints';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { listActiveCheckpointsForChat } from '../infrastructure/checkpoint-repository';

export async function listChatFileCheckpointSummaries(
  db: Kysely<Database>,
  chatId: string
): Promise<ChatFileCheckpointSummary[]> {
  const rows = await listActiveCheckpointsForChat(db, chatId);
  const byMessage = new Map<
    string,
    { fileCount: number; ops: Set<FileCheckpointOp>; createdAt: number }
  >();

  for (const row of rows) {
    const op = row.op as FileCheckpointOp;
    const existing = byMessage.get(row.messageId);
    if (!existing) {
      byMessage.set(row.messageId, {
        fileCount: 1,
        ops: new Set([op]),
        createdAt: row.createdAt,
      });
      continue;
    }
    existing.fileCount += 1;
    existing.ops.add(op);
    existing.createdAt = Math.min(existing.createdAt, row.createdAt);
  }

  return [...byMessage.entries()]
    .map(([messageId, summary]) => ({
      messageId,
      fileCount: summary.fileCount,
      ops: [...summary.ops],
      createdAt: summary.createdAt,
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}
