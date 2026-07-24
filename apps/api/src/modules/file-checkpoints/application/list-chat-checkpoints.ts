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
    { paths: Set<string>; ops: Set<FileCheckpointOp>; createdAt: number }
  >();

  for (const row of rows) {
    const op = row.op as FileCheckpointOp;
    const existing = byMessage.get(row.messageId);
    if (!existing) {
      byMessage.set(row.messageId, {
        paths: new Set([row.path]),
        ops: new Set([op]),
        createdAt: row.createdAt,
      });
      continue;
    }
    // Paths, not rows: a message may snapshot the same file more than once.
    existing.paths.add(row.path);
    existing.ops.add(op);
    existing.createdAt = Math.min(existing.createdAt, row.createdAt);
  }

  return [...byMessage.entries()]
    .map(([messageId, summary]) => ({
      messageId,
      fileCount: summary.paths.size,
      ops: [...summary.ops],
      createdAt: summary.createdAt,
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}
