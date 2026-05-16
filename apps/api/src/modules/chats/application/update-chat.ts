import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { type UpdateChatData, updateChat } from '../infrastructure/chat-repository';

export interface UpdateChatInput {
  chatId: string;
  userId: string;
  updates: UpdateChatData;
}

export async function updateChatUseCase(
  input: UpdateChatInput,
  db: Kysely<Database>
): Promise<void> {
  await updateChat(input.chatId, input.userId, input.updates, db);
}
