import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { deleteChat } from '../infrastructure/chat-repository';

export interface DeleteChatInput {
  chatId: string;
  userId: string;
}

export async function deleteChatUseCase(
  input: DeleteChatInput,
  db: Kysely<Database>
): Promise<void> {
  await deleteChat(input.chatId, input.userId, db);
}
