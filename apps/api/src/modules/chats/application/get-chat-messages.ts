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
    const chatRow = await db
      .selectFrom('chats')
      .select(['lastContextState', 'lastProviderState'])
      .where('id', '=', input.chatId)
      .executeTakeFirst();

    contextInfo = extractContextInfo(chatRow?.lastContextState, chatRow?.lastProviderState);
  }

  return { messages, nextCursor, contextInfo };
}
