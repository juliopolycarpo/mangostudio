import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { InteractionMode } from '@mangostudio/shared/types';
import type { MessagePart } from '@mangostudio/shared/types';
import { boolToInt, serializeStyleParams, parseStyleParams } from '../../../db/serializers';

export interface CreateMessageData {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl?: string | null;
  referenceImage?: string | null;
  timestamp: number;
  isGenerating: boolean;
  generationTime?: string | null;
  modelName?: string | null;
  styleParams?: string[] | null;
  interactionMode: InteractionMode;
  parts?: string | null;
  providerState?: string | null;
}

export interface UpdateMessageData {
  text?: string;
  imageUrl?: string;
  isGenerating?: boolean;
  generationTime?: string;
  modelName?: string;
  styleParams?: string[] | null;
}

export interface MessageRow {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl: string | null;
  referenceImage: string | null;
  timestamp: number;
  isGenerating: number;
  generationTime: string | null;
  modelName: string | null;
  styleParams: string | null;
  interactionMode: InteractionMode;
  parts: string | null;
  providerState: string | null;
}

export interface MappedMessage {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl: string | null;
  referenceImage: string | null;
  timestamp: number;
  isGenerating: boolean;
  generationTime: string | null;
  modelName: string | null;
  styleParams: string[] | undefined;
  interactionMode: InteractionMode;
  parts: unknown[] | undefined;
  providerState: string | null;
}

export interface SimpleTurn {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

export interface RichTurn {
  id: string;
  role: 'user' | 'ai';
  text: string;
  parts?: MessagePart[];
  providerState?: string | null;
  modelName?: string | null;
}

export interface ListByChatOptions {
  cursor?: number;
  limit?: number;
}

export interface ListHistoryOptions {
  excludeId?: string;
  limit?: number;
}

export interface GalleryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  chatId: string;
}

export interface ListGalleryOptions {
  cursor?: number;
  limit?: number;
}

export function mapMessage(row: MessageRow): MappedMessage {
  return {
    ...row,
    isGenerating: row.isGenerating === 1,
    styleParams: parseStyleParams(row.styleParams),
    parts: row.parts ? (JSON.parse(row.parts) as unknown[]) : undefined,
  };
}

export async function insertMessage(data: CreateMessageData, db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      id: data.id,
      chatId: data.chatId,
      role: data.role,
      text: data.text,
      imageUrl: data.imageUrl ?? null,
      referenceImage: data.referenceImage ?? null,
      timestamp: data.timestamp,
      isGenerating: boolToInt(data.isGenerating),
      generationTime: data.generationTime ?? null,
      modelName: data.modelName ?? null,
      styleParams: serializeStyleParams(data.styleParams),
      interactionMode: data.interactionMode,
      parts: data.parts ?? null,
      providerState: data.providerState ?? null,
    })
    .execute();
}

export async function updateMessage(
  id: string,
  data: UpdateMessageData,
  db: Kysely<Database>
): Promise<void> {
  const updates: {
    text?: string;
    imageUrl?: string;
    isGenerating?: 0 | 1;
    generationTime?: string;
    modelName?: string;
    styleParams?: string | null;
  } = {};

  if (data.text !== undefined) updates.text = data.text;
  if (data.imageUrl !== undefined) updates.imageUrl = data.imageUrl;
  if (data.isGenerating !== undefined) updates.isGenerating = boolToInt(data.isGenerating);
  if (data.generationTime !== undefined) updates.generationTime = data.generationTime;
  if (data.modelName !== undefined) updates.modelName = data.modelName;
  if (data.styleParams !== undefined) updates.styleParams = serializeStyleParams(data.styleParams);

  if (Object.keys(updates).length === 0) return;

  await db.updateTable('messages').set(updates).where('id', '=', id).execute();
}

export async function listByChatId(
  chatId: string,
  opts: ListByChatOptions,
  db: Kysely<Database>
): Promise<{ messages: MappedMessage[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 50;

  let q = db
    .selectFrom('messages')
    .selectAll()
    .where('chatId', '=', chatId)
    .orderBy('timestamp', 'asc');

  if (opts.cursor) {
    q = q.where('timestamp', '>', opts.cursor);
  }

  const rows = await q.limit(limit + 1).execute();

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const nextItem = rows.pop();
    nextCursor = nextItem?.timestamp.toString() ?? null;
  }

  return { messages: rows.map(mapMessage), nextCursor };
}

export async function loadHistory(
  chatId: string,
  opts: ListHistoryOptions,
  db: Kysely<Database>
): Promise<SimpleTurn[]> {
  let q = db
    .selectFrom('messages')
    .select(['id', 'role', 'text'])
    .where('chatId', '=', chatId)
    .where('interactionMode', '=', 'chat')
    .orderBy('timestamp', 'desc')
    .limit(opts.limit ?? 200);

  if (opts.excludeId) {
    q = q.where('id', '!=', opts.excludeId);
  }

  const rows = await q.execute();
  return rows.reverse().map((row) => ({ id: row.id, role: row.role, text: row.text }));
}

export async function loadRichHistory(
  chatId: string,
  opts: ListHistoryOptions,
  db: Kysely<Database>
): Promise<RichTurn[]> {
  let q = db
    .selectFrom('messages')
    .select(['id', 'role', 'text', 'parts', 'providerState', 'modelName'])
    .where('chatId', '=', chatId)
    .where('interactionMode', '=', 'chat')
    .orderBy('timestamp', 'desc')
    .limit(opts.limit ?? 200);

  if (opts.excludeId) {
    q = q.where('id', '!=', opts.excludeId);
  }

  const rows = await q.execute();

  return rows.reverse().map((row) => ({
    id: row.id,
    role: row.role,
    text: row.text,
    parts: row.parts ? (JSON.parse(row.parts) as MessagePart[]) : undefined,
    providerState: row.providerState ?? null,
    modelName: row.modelName ?? null,
  }));
}

export async function verifyMessageOwnership(
  messageId: string,
  userId: string,
  db: Kysely<Database>
): Promise<boolean> {
  const msg = await db
    .selectFrom('messages')
    .innerJoin('chats', 'chats.id', 'messages.chatId')
    .select(['messages.id', 'chats.userId'])
    .where('messages.id', '=', messageId)
    .executeTakeFirst();

  return !!msg && msg.userId === userId;
}

export async function listGalleryImages(
  userId: string,
  opts: ListGalleryOptions,
  db: Kysely<Database>
): Promise<{ items: GalleryItem[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 50;

  let q = db
    .selectFrom('messages as ai')
    .innerJoin('chats', 'ai.chatId', 'chats.id')
    .select([
      'ai.id',
      'ai.imageUrl',
      'ai.chatId',
      'ai.timestamp',
      (eb) =>
        eb
          .selectFrom('messages as user_msg')
          .select('user_msg.text')
          .whereRef('user_msg.chatId', '=', 'ai.chatId')
          .where('user_msg.role', '=', 'user')
          .where('user_msg.timestamp', '<=', eb.ref('ai.timestamp'))
          .orderBy('user_msg.timestamp', 'desc')
          .limit(1)
          .as('prompt'),
    ])
    .where('chats.userId', '=', userId)
    .where('ai.role', '=', 'ai')
    .where('ai.imageUrl', 'is not', null)
    .orderBy('ai.timestamp', 'desc');

  if (opts.cursor) {
    q = q.where('ai.timestamp', '<', opts.cursor);
  }

  const rows = await q.limit(limit + 1).execute();

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const nextItem = rows.pop();
    nextCursor = nextItem?.timestamp.toString() ?? null;
  }

  const items = rows
    .filter((row): row is typeof row & { imageUrl: string } => row.imageUrl !== null)
    .map((row) => ({
      id: row.id,
      imageUrl: row.imageUrl,
      prompt: row.prompt ?? 'Generated Image',
      chatId: row.chatId,
    }));

  return { items, nextCursor };
}
