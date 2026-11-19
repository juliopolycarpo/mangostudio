import type { Chat } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { ChatNotFoundError } from '../domain/chat-ownership';
import { getByIdWithState } from '../infrastructure/chat-repository';
import { extractContextInfo } from './list-chats';
import { toPublicChat } from './public-chat';

/**
 * One chat of `userId`, shaped as the list shows it. A chat that does not
 * exist and one another account owns are the same {@link ChatNotFoundError}, so
 * the answer never reveals which ids are taken.
 *
 * @example
 * const chat = await getChatUseCase({ chatId, userId }, db);
 */
export async function getChatUseCase(
  input: { chatId: string; userId: string },
  db: Kysely<Database>
): Promise<Chat> {
  const row = await getByIdWithState(input.chatId, db);
  if (row?.userId !== input.userId) throw new ChatNotFoundError(input.chatId);
  return toPublicChat(row, extractContextInfo(row.lastContextState, row.lastProviderState));
}
