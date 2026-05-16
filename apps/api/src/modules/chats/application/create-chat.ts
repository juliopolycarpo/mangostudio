import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  type ChatRecord,
  type CreateChatData,
  createChat,
} from '../infrastructure/chat-repository';

export interface CreateChatInput {
  title: string;
  model?: string | null;
  userId: string;
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
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
