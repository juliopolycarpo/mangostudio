import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { verifyChatOwnership } from '../infrastructure/chat-repository';

export { verifyChatOwnership };

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

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = 'ChatNotFoundError';
  }
}
