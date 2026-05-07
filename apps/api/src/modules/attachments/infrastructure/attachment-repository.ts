import type { Kysely } from 'kysely';
import type { ChatAttachment } from '@mangostudio/shared/chat';
import type { ChatAttachmentInsert, ChatAttachmentSelect, Database } from '../../../db/types';

export class ChatAttachmentNotFoundError extends Error {
  constructor() {
    super('One or more attachments were not found for this chat.');
    this.name = 'ChatAttachmentNotFoundError';
  }
}

export interface CreateChatAttachmentData {
  id: string;
  userId: string;
  chatId: string;
  originalName: string;
  storedName: string;
  relativePath: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachment['kind'];
  createdAt: number;
}

export async function insertChatAttachment(
  data: CreateChatAttachmentData,
  db: Kysely<Database>
): Promise<ChatAttachment> {
  const row: ChatAttachmentInsert = {
    ...data,
    messageId: null,
    updatedAt: data.createdAt,
  };

  await db.insertInto('chat_attachments').values(row).execute();
  return mapChatAttachment(row);
}

export async function listAttachmentsByMessageIds(
  messageIds: string[],
  db: Kysely<Database>
): Promise<Map<string, ChatAttachment[]>> {
  if (messageIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('chat_attachments')
    .selectAll()
    .where('messageId', 'in', messageIds)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const attachmentsByMessageId = new Map<string, ChatAttachment[]>();
  for (const row of rows) {
    if (!row.messageId) continue;
    const attachments = attachmentsByMessageId.get(row.messageId) ?? [];
    attachments.push(mapChatAttachment(row));
    attachmentsByMessageId.set(row.messageId, attachments);
  }

  return attachmentsByMessageId;
}

export async function linkAttachmentsToMessage(
  input: {
    attachmentIds: string[];
    userId: string;
    chatId: string;
    messageId: string;
    updatedAt: number;
  },
  db: Kysely<Database>
): Promise<ChatAttachment[]> {
  const attachmentIds = uniqueAttachmentIds(input.attachmentIds);
  if (attachmentIds.length === 0) return [];

  const attachments = await assertChatAttachmentIdsAvailable(
    {
      attachmentIds,
      userId: input.userId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    db
  );

  await db
    .updateTable('chat_attachments')
    .set({ messageId: input.messageId, updatedAt: input.updatedAt })
    .where('id', 'in', attachmentIds)
    .where('userId', '=', input.userId)
    .where('chatId', '=', input.chatId)
    .where((eb) => eb.or([eb('messageId', 'is', null), eb('messageId', '=', input.messageId)]))
    .execute();

  return attachments.map((attachment) => ({
    ...mapChatAttachment(attachment),
    messageId: input.messageId,
  }));
}

export async function assertChatAttachmentIdsAvailable(
  input: { attachmentIds: string[]; userId: string; chatId: string; messageId?: string },
  db: Kysely<Database>
): Promise<ChatAttachmentSelect[]> {
  const attachmentIds = uniqueAttachmentIds(input.attachmentIds);
  if (attachmentIds.length === 0) return [];

  const attachments = await listAttachableRows(
    {
      attachmentIds,
      userId: input.userId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    db
  );

  if (attachments.length !== attachmentIds.length) {
    throw new ChatAttachmentNotFoundError();
  }

  return attachments;
}

async function listAttachableRows(
  input: { attachmentIds: string[]; userId: string; chatId: string; messageId?: string },
  db: Kysely<Database>
): Promise<ChatAttachmentSelect[]> {
  let query = db
    .selectFrom('chat_attachments')
    .selectAll()
    .where('id', 'in', input.attachmentIds)
    .where('userId', '=', input.userId)
    .where('chatId', '=', input.chatId);

  const messageId = input.messageId;
  query = messageId
    ? query.where((eb) => eb.or([eb('messageId', 'is', null), eb('messageId', '=', messageId)]))
    : query.where('messageId', 'is', null);

  return query.execute();
}

function uniqueAttachmentIds(attachmentIds: string[]): string[] {
  return Array.from(new Set(attachmentIds.filter((id) => id.trim().length > 0)));
}

function mapChatAttachment(row: ChatAttachmentSelect | ChatAttachmentInsert): ChatAttachment {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    url: row.url,
    createdAt: row.createdAt,
  };
}
