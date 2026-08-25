import type { Chat } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { recordActivity } from '../../activity/application/record-activity';
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
  const chat = await createChat(data, db);

  void recordActivity(
    {
      userId: input.userId,
      kind: 'chat_created',
      chatId: chat.id,
      environmentId: chat.environmentId,
      // A chat has no workdir at creation; one is chosen later, and the turns
      // that run in it carry it.
      payload: { title: chat.title },
    },
    { db }
  );

  return toPublicChat(chat);
}
