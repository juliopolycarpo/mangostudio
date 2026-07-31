import type { Chat } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { type CreateChatData, createChat } from '../infrastructure/chat-repository';
import { toPublicChat } from './public-chat';

export interface CreateChatInput {
  title: string;
  model?: string | null;
  userId: string;
}

export async function createChatUseCase(
  input: CreateChatInput,
  db: Kysely<Database>
): Promise<Chat> {
  const data: CreateChatData = {
    title: input.title,
    model: input.model,
    userId: input.userId,
  };
  return toPublicChat(await createChat(data, db));
}
