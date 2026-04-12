import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { assertChatOwnership } from '../domain/chat-ownership';
import { listByChatId } from '../../messages/infrastructure/message-repository';
import { extractContextInfo, type ContextInfo } from './list-chats';

export interface GetChatMessagesInput {
  chatId: string;
  userId: string;
  cursor?: number;
  limit?: number;
}

export async function getChatMessagesUseCase(input: GetChatMessagesInput, db: Kysely<Database>) {
  await assertChatOwnership(input.chatId, input.userId, db);

  const { messages, nextCursor } = await listByChatId(
    input.chatId,
    { cursor: input.cursor, limit: input.limit },
    db
  );

  let contextInfo: ContextInfo | null = null;

  if (!input.cursor) {
    const lastAiRow = await db
      .selectFrom('messages')
      .select('providerState')
      .where('chatId', '=', input.chatId)
      .where('role', '=', 'ai')
      .where('providerState', 'is not', null)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .executeTakeFirst();

    contextInfo = extractContextInfo(lastAiRow?.providerState as string | null);
  }

  return { messages, nextCursor, contextInfo };
}
