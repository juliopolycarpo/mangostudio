import type { Kysely } from 'kysely';
import type { Database, FileCheckpointInsert, FileCheckpointSelect } from '../../../db/types';
import { checkpointBlobSize, deleteCheckpointBlobIfUnreferenced } from './checkpoint-blob-store';

const MAX_CHECKPOINT_MESSAGES_PER_CHAT = 50;
const MAX_CHECKPOINT_BYTES_PER_CHAT = 256 * 1024 * 1024;

/**
 * The message's snapshot of what currently sits at `path`, or undefined when
 * nothing does. The last mutation to start there wins, and a `movedTo` row
 * carried its content away — that hands the path back, so the next mutation on
 * it needs a snapshot of its own.
 */
export async function findCheckpointRow(
  db: Kysely<Database>,
  chatId: string,
  messageId: string,
  path: string
): Promise<FileCheckpointSelect | undefined> {
  const latest = await db
    .selectFrom('file_checkpoints')
    .selectAll()
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .where('path', '=', path)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  return latest?.movedTo === null ? latest : undefined;
}

/** Opens a manifest row, returning the id its after-hash will be recorded against. */
export async function insertCheckpointRow(
  db: Kysely<Database>,
  row: Omit<FileCheckpointInsert, 'id' | 'createdAt' | 'revertedAt'>
): Promise<number> {
  const { id } = await db
    .insertInto('file_checkpoints')
    .values({ createdAt: Date.now(), revertedAt: null, ...row })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

export async function updateCheckpointAfterHash(
  db: Kysely<Database>,
  id: number,
  afterHash: string | null
): Promise<void> {
  await db.updateTable('file_checkpoints').set({ afterHash }).where('id', '=', id).execute();
}

/**
 * Revertable rows only: a NULL `afterHash` marks a tool that threw before it
 * finished, so the row records no completed mutation to undo.
 */
export async function listActiveCheckpointsForChat(
  db: Kysely<Database>,
  chatId: string
): Promise<FileCheckpointSelect[]> {
  return await db
    .selectFrom('file_checkpoints')
    .selectAll()
    .where('chatId', '=', chatId)
    .where('revertedAt', 'is', null)
    .where('afterHash', 'is not', null)
    .orderBy('id', 'asc')
    .execute();
}

/** Ascending id, i.e. the order the mutations happened; revert replays it backwards. */
export async function listActiveCheckpointsForMessage(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<FileCheckpointSelect[]> {
  return await db
    .selectFrom('file_checkpoints')
    .selectAll()
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .where('revertedAt', 'is', null)
    .where('afterHash', 'is not', null)
    .orderBy('id', 'asc')
    .execute();
}

export async function markMessageCheckpointsReverted(
  db: Kysely<Database>,
  chatId: string,
  messageId: string,
  revertedAt: number
): Promise<void> {
  await db
    .updateTable('file_checkpoints')
    .set({ revertedAt })
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .where('revertedAt', 'is', null)
    .execute();
}

async function isBlobKeyReferenced(db: Kysely<Database>, blobKey: string): Promise<boolean> {
  const row = await db
    .selectFrom('file_checkpoints')
    .select('id')
    .where('blobKey', '=', blobKey)
    .executeTakeFirst();
  return row !== undefined;
}

/** Every distinct blob a chat's checkpoints reference, captured before deletion. */
export async function listChatCheckpointBlobKeys(
  db: Kysely<Database>,
  chatId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('file_checkpoints')
    .select('blobKey')
    .where('chatId', '=', chatId)
    .where('blobKey', 'is not', null)
    .execute();
  return [...new Set(rows.map((row) => row.blobKey).filter((key): key is string => !!key))];
}

/**
 * Drops blobs no surviving row points at. Callers must delete the rows first:
 * a blob is only unreferenced once its last manifest row is gone.
 */
export async function releaseCheckpointBlobs(
  db: Kysely<Database>,
  blobKeys: readonly string[]
): Promise<void> {
  for (const blobKey of blobKeys) {
    await deleteCheckpointBlobIfUnreferenced(blobKey, (key) => isBlobKeyReferenced(db, key));
  }
}

export async function enforceChatRetention(db: Kysely<Database>, chatId: string): Promise<void> {
  // Every message, reverted or not: reverted rows still pin blobs on disk, so
  // leaving them out would make the byte budget unreclaimable.
  const rows = await db
    .selectFrom('file_checkpoints')
    .select(['messageId', 'createdAt'])
    .where('chatId', '=', chatId)
    .execute();

  const earliestByMessage = new Map<string, number>();
  for (const row of rows) {
    const prev = earliestByMessage.get(row.messageId);
    if (prev === undefined || row.createdAt < prev) {
      earliestByMessage.set(row.messageId, row.createdAt);
    }
  }

  const messagesByAge = [...earliestByMessage.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([messageId]) => messageId);

  if (messagesByAge.length > MAX_CHECKPOINT_MESSAGES_PER_CHAT) {
    const toDrop = messagesByAge.slice(0, messagesByAge.length - MAX_CHECKPOINT_MESSAGES_PER_CHAT);
    for (const messageId of toDrop) {
      await deleteMessageCheckpoints(db, chatId, messageId);
    }
  }

  let totalBytes = await sumChatBlobBytes(db, chatId);
  if (totalBytes <= MAX_CHECKPOINT_BYTES_PER_CHAT) return;

  for (const messageId of messagesByAge) {
    if (totalBytes <= MAX_CHECKPOINT_BYTES_PER_CHAT) break;
    await deleteMessageCheckpoints(db, chatId, messageId);
    totalBytes = await sumChatBlobBytes(db, chatId);
  }
}

async function sumChatBlobBytes(db: Kysely<Database>, chatId: string): Promise<number> {
  const keys = await listChatCheckpointBlobKeys(db, chatId);
  let totalBytes = 0;
  for (const blobKey of keys) totalBytes += checkpointBlobSize(blobKey);
  return totalBytes;
}

async function deleteMessageCheckpoints(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<void> {
  // Every row for the message, not just the revertable ones: the delete below is
  // unfiltered, so any blob left out here would be orphaned on disk forever.
  const rows = await db
    .selectFrom('file_checkpoints')
    .select('blobKey')
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .where('blobKey', 'is not', null)
    .execute();
  const blobKeys = [...new Set(rows.map((r) => r.blobKey).filter((k): k is string => !!k))];
  await db
    .deleteFrom('file_checkpoints')
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .execute();
  await releaseCheckpointBlobs(db, blobKeys);
}
