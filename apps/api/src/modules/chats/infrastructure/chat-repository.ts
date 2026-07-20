import type { Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';

function mapChatRow(row: Selectable<Database['chats']>): ChatRecord {
  return {
    ...row,
    restrictToolsToWorkdir:
      row.restrictToolsToWorkdir === null || row.restrictToolsToWorkdir === undefined
        ? null
        : row.restrictToolsToWorkdir !== 0,
  };
}

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
  restrictToolsToWorkdir?: boolean | null;
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
  restrictToolsToWorkdir: boolean | null;
  userId: string | null;
  lastProviderState: string | null;
  lastContextState: string | null;
}

export async function listByUserId(userId: string, db: Kysely<Database>): Promise<ChatRecord[]> {
  const rows = await db
    .selectFrom('chats')
    .selectAll()
    .where('userId', '=', userId)
    .orderBy('updatedAt', 'desc')
    .execute();
  return rows.map(mapChatRow);
}

export async function getById(id: string, db: Kysely<Database>): Promise<ChatRecord | undefined> {
  const row = await db.selectFrom('chats').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? mapChatRow(row) : undefined;
}

export async function createChat(data: CreateChatData, db: Kysely<Database>): Promise<ChatRecord> {
  const now = Date.now();
  const chat: ChatRecord = {
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
    restrictToolsToWorkdir: null,
    userId: data.userId,
    lastProviderState: null,
    lastContextState: null,
  };
  await db
    .insertInto('chats')
    .values({
      ...chat,
      restrictToolsToWorkdir: null,
    })
    .execute();
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
  if (data.restrictToolsToWorkdir !== undefined) {
    updates.restrictToolsToWorkdir = data.restrictToolsToWorkdir;
  }

  if (Object.keys(updates).length === 0) return;

  const dbUpdates: Updateable<Database['chats']> = {};
  if (updates.title !== undefined) dbUpdates.title = updates.title;
  if (updates.model !== undefined) dbUpdates.model = updates.model;
  if (updates.textModel !== undefined) dbUpdates.textModel = updates.textModel;
  if (updates.imageModel !== undefined) dbUpdates.imageModel = updates.imageModel;
  if (updates.lastUsedMode !== undefined) dbUpdates.lastUsedMode = updates.lastUsedMode;
  if (updates.selectedAgentId !== undefined) dbUpdates.selectedAgentId = updates.selectedAgentId;
  if (updates.workdir !== undefined) dbUpdates.workdir = updates.workdir;
  if (data.restrictToolsToWorkdir !== undefined) {
    dbUpdates.restrictToolsToWorkdir =
      data.restrictToolsToWorkdir === null ? null : data.restrictToolsToWorkdir ? 1 : 0;
  }

  await db
    .updateTable('chats')
    .set(dbUpdates)
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
  restrictToolsToWorkdir: boolean | null;
}

export async function getOwnedChat(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<OwnedChatRecord | undefined> {
  const row = await db
    .selectFrom('chats')
    .select(['workdir', 'restrictToolsToWorkdir'])
    .where('id', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    workdir: row.workdir,
    restrictToolsToWorkdir:
      row.restrictToolsToWorkdir === null || row.restrictToolsToWorkdir === undefined
        ? null
        : row.restrictToolsToWorkdir !== 0,
  };
}
