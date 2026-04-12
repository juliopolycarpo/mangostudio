import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { InteractionMode } from '@mangostudio/shared/types';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
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

  await db
    .updateTable('chats')
    .set({ updatedAt: input.timestamp })
    .where('id', '=', input.chatId)
    .execute();
}
