import type { Kysely } from 'kysely';
import type { Database, FileCheckpointInsert, FileCheckpointSelect } from '../../../db/types';
import { generateId } from '../../../utils/id';
import { deleteCheckpointBlobIfUnreferenced, readCheckpointBlob } from './checkpoint-blob-store';

export type FileCheckpointOp = 'create' | 'edit' | 'delete' | 'move';

const MAX_CHECKPOINT_MESSAGES_PER_CHAT = 50;
const MAX_CHECKPOINT_BYTES_PER_CHAT = 256 * 1024 * 1024;

export async function findCheckpointRow(
  db: Kysely<Database>,
  chatId: string,
  messageId: string,
  path: string
): Promise<FileCheckpointSelect | undefined> {
  return await db
    .selectFrom('file_checkpoints')
    .selectAll()
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .where('path', '=', path)
    .executeTakeFirst();
}

export async function insertCheckpointRow(
  db: Kysely<Database>,
  row: Omit<FileCheckpointInsert, 'id' | 'createdAt' | 'revertedAt'>
): Promise<FileCheckpointSelect> {
  const created: FileCheckpointInsert = {
    id: generateId(),
    createdAt: Date.now(),
    revertedAt: null,
    ...row,
  };
  await db.insertInto('file_checkpoints').values(created).execute();
  return created as FileCheckpointSelect;
}

export async function updateCheckpointAfterHash(
  db: Kysely<Database>,
  id: string,
  afterHash: string | null
): Promise<void> {
  await db.updateTable('file_checkpoints').set({ afterHash }).where('id', '=', id).execute();
}

export async function listActiveCheckpointsForChat(
  db: Kysely<Database>,
  chatId: string
): Promise<FileCheckpointSelect[]> {
  return await db
    .selectFrom('file_checkpoints')
    .selectAll()
    .where('chatId', '=', chatId)
    .where('revertedAt', 'is', null)
    .orderBy('createdAt', 'asc')
    .execute();
}

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
    .orderBy('createdAt', 'asc')
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

export async function purgeChatCheckpointBlobs(
  db: Kysely<Database>,
  chatId: string
): Promise<void> {
  const rows = await db
    .selectFrom('file_checkpoints')
    .select('blobKey')
    .where('chatId', '=', chatId)
    .where('blobKey', 'is not', null)
    .execute();
  const keys = [...new Set(rows.map((row) => row.blobKey).filter((key): key is string => !!key))];
  for (const blobKey of keys) {
    await deleteCheckpointBlobIfUnreferenced(blobKey, (key) => isBlobKeyReferenced(db, key));
  }
}

export async function enforceChatRetention(db: Kysely<Database>, chatId: string): Promise<void> {
  const rows = await db
    .selectFrom('file_checkpoints')
    .select(['messageId', 'createdAt'])
    .where('chatId', '=', chatId)
    .where('revertedAt', 'is', null)
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
  const blobRows = await db
    .selectFrom('file_checkpoints')
    .select(['blobKey'])
    .where('chatId', '=', chatId)
    .where('blobKey', 'is not', null)
    .execute();

  let totalBytes = 0;
  const keys = [...new Set(blobRows.map((r) => r.blobKey).filter((k): k is string => !!k))];
  for (const blobKey of keys) {
    const bytes = await readCheckpointBlob(blobKey);
    if (bytes) totalBytes += bytes.byteLength;
  }
  return totalBytes;
}

async function deleteMessageCheckpoints(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<void> {
  const rows = await listActiveCheckpointsForMessage(db, chatId, messageId);
  const blobKeys = [...new Set(rows.map((r) => r.blobKey).filter((k): k is string => !!k))];
  await db
    .deleteFrom('file_checkpoints')
    .where('chatId', '=', chatId)
    .where('messageId', '=', messageId)
    .execute();
  for (const blobKey of blobKeys) {
    await deleteCheckpointBlobIfUnreferenced(blobKey, (key) => isBlobKeyReferenced(db, key));
  }
}
