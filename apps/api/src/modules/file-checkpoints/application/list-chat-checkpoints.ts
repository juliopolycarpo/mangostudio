import type {
  ChatFileCheckpointSummary,
  FileCheckpointOp,
} from '@mangostudio/shared/file-checkpoints';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { listActiveCheckpointsForChat } from '../infrastructure/checkpoint-repository';
import { listUncheckpointedSourcesByMessage } from '../infrastructure/uncheckpointed-source-repository';

/**
 * The revert preview, per message: what reverting would undo, and — since the
 * manifest only covers builtin mutators — which classes of write it would
 * leave in place.
 *
 * Messages with no manifest rows stay out of the list even when they ran shell
 * or MCP tools. Nothing there claims to be revertable, so there is nothing to
 * qualify.
 */
export async function listChatFileCheckpointSummaries(
  db: Kysely<Database>,
  chatId: string
): Promise<ChatFileCheckpointSummary[]> {
  const rows = await listActiveCheckpointsForChat(db, chatId);
  const uncheckpointedByMessage = await listUncheckpointedSourcesByMessage(db, chatId);
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
      uncheckpointedSources: uncheckpointedByMessage.get(messageId) ?? [],
      createdAt: summary.createdAt,
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}
