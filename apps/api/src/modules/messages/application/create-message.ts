import type { InteractionMode } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
import { updateChatAfterTurn } from '../../generation/infrastructure/conversation-persistence';
import { insertMessage } from '../infrastructure/message-repository';

export interface CreateMessageInput {
  id: string;
  chatId: string;
  userId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl?: string | null;
  referenceImage?: string | null;
  timestamp: number;
  isGenerating?: boolean;
  generationTime?: string | null;
  modelName?: string | null;
  styleParams?: string[] | null;
  interactionMode: InteractionMode;
}

export async function createMessageUseCase(
  input: CreateMessageInput,
  db: Kysely<Database>
): Promise<void> {
  await assertChatOwnership(input.chatId, input.userId, db);

  await insertMessage(
    {
      id: input.id,
      chatId: input.chatId,
      role: input.role,
      text: input.text,
      imageUrl: input.imageUrl,
      referenceImage: input.referenceImage,
      timestamp: input.timestamp,
      isGenerating: input.isGenerating ?? false,
      generationTime: input.generationTime,
      modelName: input.modelName,
      styleParams: input.styleParams,
      interactionMode: input.interactionMode,
    },
    db
  );

  // No feed row: a message written straight through this route is not a turn
  // anything ran, so there is nothing to describe. The chat list is still owed
  // its signal, and the helper that moves the timestamp sends it.
  await updateChatAfterTurn(input.chatId, input.userId, input.timestamp, db);
}
