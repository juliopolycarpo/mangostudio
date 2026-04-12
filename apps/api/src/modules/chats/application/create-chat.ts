import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  createChat,
  type CreateChatData,
  type ChatRecord,
} from '../infrastructure/chat-repository';

export interface CreateChatInput {
  title: string;
  model?: string | null;
  userId: string;
}

export async function createChatUseCase(
  input: CreateChatInput,
  db: Kysely<Database>
): Promise<ChatRecord> {
  const data: CreateChatData = {
    title: input.title,
    model: input.model,
    userId: input.userId,
  };
  return createChat(data, db);
}
