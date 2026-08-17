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

/** Every message of a chat that ran an uncheckpointed mutator, keyed by message. */
export async function listUncheckpointedSourcesByMessage(
  db: Kysely<Database>,
  chatId: string
): Promise<ReadonlyMap<string, ReadonlyArray<UncheckpointedWriteSource>>> {
  const rows = await db
    .selectFrom('message_uncheckpointed_sources')
    .select(['messageId', 'source'])
    .where('chatId', '=', chatId)
    .execute();

  const byMessage = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byMessage.get(row.messageId);
    if (existing) existing.push(row.source);
    else byMessage.set(row.messageId, [row.source]);
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
function orderSources(sources: readonly string[]): ReadonlyArray<UncheckpointedWriteSource> {
  const present = new Set(sources);
  return UNCHECKPOINTED_WRITE_SOURCES.filter((source) => present.has(source));
}
