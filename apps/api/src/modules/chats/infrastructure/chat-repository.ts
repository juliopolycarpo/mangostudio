import type { InteractionMode } from '@mangostudio/shared';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';

/** SQLite stores the tri-state override as NULL (inherit) or 0/1. */
function toOverrideFlag(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

function mapChatRow(row: Selectable<Database['chats']>): ChatRecord {
  return {
    ...row,
    lastUsedMode: row.lastUsedMode as InteractionMode | null,
    restrictToolsToWorkdir: toOverrideFlag(row.restrictToolsToWorkdir),
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
  environmentId?: string;
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
  lastUsedMode: InteractionMode | null;
  selectedAgentId: string | null;
  workdir: string | null;
  environmentId: string;
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
    environmentId: LOCAL_ENVIRONMENT_ID,
    restrictToolsToWorkdir: null,
    userId: data.userId,
    lastProviderState: null,
    lastContextState: null,
  };
  await db
    .insertInto('chats')
    .values({ ...chat, restrictToolsToWorkdir: null })
    .execute();
  return chat;
}

export async function updateChat(
  id: string,
  userId: string,
  data: UpdateChatData,
  db: Kysely<Database>
): Promise<void> {
  const dbUpdates: Updateable<Database['chats']> = {};
  if (data.title !== undefined) dbUpdates.title = data.title;
  if (data.model !== undefined) dbUpdates.model = data.model;
  if (data.textModel !== undefined) dbUpdates.textModel = data.textModel;
  if (data.imageModel !== undefined) dbUpdates.imageModel = data.imageModel;
  if (data.lastUsedMode !== undefined) dbUpdates.lastUsedMode = data.lastUsedMode;
  if (data.selectedAgentId !== undefined) dbUpdates.selectedAgentId = data.selectedAgentId;
  if (data.workdir !== undefined) dbUpdates.workdir = data.workdir;
  if (data.environmentId !== undefined) dbUpdates.environmentId = data.environmentId;
  if (data.restrictToolsToWorkdir !== undefined) {
    dbUpdates.restrictToolsToWorkdir =
      data.restrictToolsToWorkdir === null ? null : data.restrictToolsToWorkdir ? 1 : 0;
  }

  if (Object.keys(dbUpdates).length === 0) return;

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
  environmentId: string;
  restrictToolsToWorkdir: boolean | null;
}

export async function getOwnedChat(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<OwnedChatRecord | undefined> {
  const row = await db
    .selectFrom('chats')
    .select(['workdir', 'environmentId', 'restrictToolsToWorkdir'])
    .where('id', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    workdir: row.workdir,
    environmentId: row.environmentId,
    restrictToolsToWorkdir: toOverrideFlag(row.restrictToolsToWorkdir),
  };
}
