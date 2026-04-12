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
  userId: string | null;
  lastProviderState: string | null;
}

export async function listByUserId(userId: string, db: Kysely<Database>): Promise<ChatRecord[]> {
  return db
    .selectFrom('chats')
    .selectAll()
    .where('userId', '=', userId)
    .orderBy('updatedAt', 'desc')
    .execute();
}

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
    userId: data.userId,
    lastProviderState: null,
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
