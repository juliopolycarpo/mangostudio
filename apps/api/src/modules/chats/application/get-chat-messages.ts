import type { ContextInfo } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { decodeTranscriptCursor } from '../../messages/domain/transcript-cursor';
import { listByChatId } from '../../messages/infrastructure/message-repository';
import { assertChatOwnership } from '../domain/chat-ownership';
import { extractContextInfo } from './list-chats';

export interface GetChatMessagesInput {
  chatId: string;
  userId: string;
  /** Opaque `nextCursor` of the previous page; throws `InvalidTranscriptCursorError` otherwise. */
  cursor?: string;
  limit?: number;
}

export async function getChatMessagesUseCase(input: GetChatMessagesInput, db: Kysely<Database>) {
  const cursor = input.cursor ? decodeTranscriptCursor(input.cursor) : undefined;
  await assertChatOwnership(input.chatId, input.userId, db);

  const { messages, nextCursor } = await listByChatId(
    input.chatId,
    { cursor, limit: input.limit },
    db
  );

  let contextInfo: ContextInfo | null = null;

  if (!cursor) {
    const chatRow = await db
      .selectFrom('chats')
      .select(['lastContextState', 'lastProviderState'])
      .where('id', '=', input.chatId)
      .executeTakeFirst();

    contextInfo = extractContextInfo(chatRow?.lastContextState, chatRow?.lastProviderState);
  }

  return { messages, nextCursor, contextInfo };
}
