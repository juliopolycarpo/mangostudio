import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';

export interface CreateChatData {
  title: string;
  model?: string | null;
  userId: string;
}

export interface UpdateChatData {
  title?: string;
  model?: string;
  textModel?: string;
  imageModel?: string;
  lastUsedMode?: string;
  selectedAgentId?: string;
  workdir?: string | null;
}

export interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  textModel: string | null;
  imageModel: string | null;
  lastUsedMode: string | null;
  selectedAgentId: string | null;
  workdir: string | null;
  userId: string | null;
  lastProviderState: string | null;
  lastContextState: string | null;
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function listByUserId(userId: string, db: Kysely<Database>): Promise<ChatRecord[]> {
  return db
    .selectFrom('chats')
    .selectAll()
    .where('userId', '=', userId)
    .orderBy('updatedAt', 'desc')
    .execute();
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function getById(id: string, db: Kysely<Database>): Promise<ChatRecord | undefined> {
  return db.selectFrom('chats').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function createChat(data: CreateChatData, db: Kysely<Database>): Promise<ChatRecord> {
  const now = Date.now();
  const chat = {
    id: generateId(),
    title: data.title,
    createdAt: now,
    updatedAt: now,
    model: data.model ?? null,
    textModel: null,
    imageModel: null,
    lastUsedMode: null,
    selectedAgentId: null,
    workdir: null,
    userId: data.userId,
    lastProviderState: null,
    lastContextState: null,
  };
  await db.insertInto('chats').values(chat).execute();
  return chat;
}

export async function updateChat(
  id: string,
  userId: string,
  data: UpdateChatData,
  db: Kysely<Database>
): Promise<void> {
  const updates: UpdateChatData = {};
  if (data.title !== undefined) updates.title = data.title;
  if (data.model !== undefined) updates.model = data.model;
  if (data.textModel !== undefined) updates.textModel = data.textModel;
  if (data.imageModel !== undefined) updates.imageModel = data.imageModel;
  if (data.lastUsedMode !== undefined) updates.lastUsedMode = data.lastUsedMode;
  if (data.selectedAgentId !== undefined) updates.selectedAgentId = data.selectedAgentId;
  if (data.workdir !== undefined) updates.workdir = data.workdir;

  if (Object.keys(updates).length === 0) return;

  await db
    .updateTable('chats')
    .set(updates)
    .where('id', '=', id)
    .where('userId', '=', userId)
    .execute();
}

export async function deleteChat(id: string, userId: string, db: Kysely<Database>): Promise<void> {
  await db.deleteFrom('chats').where('id', '=', id).where('userId', '=', userId).execute();
}

export async function verifyChatOwnership(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<boolean> {
  const chat = await db
    .selectFrom('chats')
    .select('userId')
    .where('id', '=', chatId)
    .executeTakeFirst();
  return chat?.userId === userId;
}

/** Chat fields a generation turn needs; excludes the large persisted state blobs. */
export interface OwnedChatRecord {
  workdir: string | null;
}

// biome-ignore lint/suspicious/useAwait: Kysely returns a promise-like query result.
export async function getOwnedChat(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<OwnedChatRecord | undefined> {
  return db
    .selectFrom('chats')
    .select('workdir')
    .where('id', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
}
