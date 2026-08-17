import {
  UNCHECKPOINTED_WRITE_SOURCES,
  type UncheckpointedWriteSource,
} from '@mangostudio/shared/file-checkpoints';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';

/**
 * Marks a message as having run a class of tool whose writes no checkpoint
 * describes. Repeating a source is the normal case — a turn runs many shell
 * commands — so the insert is a no-op on conflict rather than a read followed
 * by a write, which the concurrent tool calls of one turn would race.
 */
export async function recordUncheckpointedSource(
  db: Kysely<Database>,
  input: { chatId: string; messageId: string; source: UncheckpointedWriteSource }
): Promise<void> {
  await db
    .insertInto('message_uncheckpointed_sources')
    .values({ ...input, createdAt: Date.now() })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

export async function listUncheckpointedSourcesForMessage(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<ReadonlyArray<UncheckpointedWriteSource>> {
  const rows = await db
    .selectFrom('message_uncheckpointed_sources')
    .select('source')
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .execute();
  return orderSources(rows.map((row) => row.source));
}

/**
 * The uncheckpointed sources of the given messages, keyed by message.
 *
 * Scoped to the ids the caller will actually read rather than the whole chat:
 * rows survive for turns that never produced a manifest, and the manifest list
 * itself is capped, so a long-lived chat accumulates sources that no response
 * can ever mention.
 */
export async function listUncheckpointedSourcesByMessage(
  db: Kysely<Database>,
  chatId: string,
  messageIds: readonly string[]
): Promise<ReadonlyMap<string, ReadonlyArray<UncheckpointedWriteSource>>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('message_uncheckpointed_sources')
    .select(['messageId', 'source'])
    .where('chatId', '=', chatId)
    .where('messageId', 'in', messageIds)
    .execute();

  const byMessage = new Map<string, Set<string>>();
  for (const row of rows) {
    const existing = byMessage.get(row.messageId);
    if (existing) existing.add(row.source);
    else byMessage.set(row.messageId, new Set([row.source]));
  }
  return new Map(
    [...byMessage].map(([messageId, sources]) => [messageId, orderSources(sources)] as const)
  );
}

export async function deleteMessageUncheckpointedSources(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<void> {
  await db
    .deleteFrom('message_uncheckpointed_sources')
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .execute();
}

/**
 * Stable declared order, and the boundary where a stored value that is no
 * longer a source this build knows about is dropped. The column is free text in
 * SQLite, so this is the only place the union is actually enforced.
 */
function orderSources(sources: Iterable<string>): ReadonlyArray<UncheckpointedWriteSource> {
  const present = sources instanceof Set ? sources : new Set(sources);
  return UNCHECKPOINTED_WRITE_SOURCES.filter((source) => present.has(source));
}
