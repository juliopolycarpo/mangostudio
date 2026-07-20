import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  getOwnedChat,
  type OwnedChatRecord,
  verifyChatOwnership,
} from '../infrastructure/chat-repository';

export async function assertChatOwnership(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<void> {
  const owns = await verifyChatOwnership(chatId, userId, db);
  if (!owns) {
    throw new ChatNotFoundError(chatId);
  }
}

export async function getOwnedChatOrThrow(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<OwnedChatRecord> {
  const chat = await getOwnedChat(chatId, userId, db);
  if (!chat) {
    throw new ChatNotFoundError(chatId);
  }
  return chat;
}

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = 'ChatNotFoundError';
  }
}
