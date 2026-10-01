import type { ContextInfo, MessagesOrder } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { decodeTranscriptCursor } from '../../messages/domain/transcript-cursor';
import { listByChatId } from '../../messages/infrastructure/message-repository';
import { assertChatOwnership } from '../domain/chat-ownership';
import { extractContextInfo } from './list-chats';

export interface GetChatMessagesInput {
  chatId: string;
  userId: string;
  /**
   * Opaque `nextCursor` of the previous page. Omit it for the first page; any present
   * value, including an empty string, that is not a cursor throws `InvalidTranscriptCursorError`.
   */
  cursor?: string;
  limit?: number;
  /** `asc` (the default) pages from the oldest end, `desc` from the newest. */
  order?: MessagesOrder;
}

export async function getChatMessagesUseCase(input: GetChatMessagesInput, db: Kysely<Database>) {
  const order = input.order ?? 'asc';
  const cursor =
    input.cursor === undefined ? undefined : decodeTranscriptCursor(input.cursor, order);
  await assertChatOwnership(input.chatId, input.userId, db);

  const { messages, nextCursor } = await listByChatId(
    input.chatId,
    { cursor, limit: input.limit, order },
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
