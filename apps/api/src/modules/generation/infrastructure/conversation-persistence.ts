import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { MessagePart } from '@mangostudio/shared/types';
import {
  insertMessage,
  type CreateMessageData,
} from '../../messages/infrastructure/message-repository';
import { insertGeneratedImageArtifact } from '../../generated-images/infrastructure/generated-image-repository';

export interface PersistUserMessageInput {
  id: string;
  chatId: string;
  text: string;
  timestamp: number;
}

export async function persistUserMessage(
  input: PersistUserMessageInput,
  db: Kysely<Database>
): Promise<void> {
  await insertMessage(
    {
      id: input.id,
      chatId: input.chatId,
      role: 'user',
      text: input.text,
      timestamp: input.timestamp,
      isGenerating: false,
      interactionMode: 'chat',
    },
    db
  );
}

export interface PersistAiResponseInput {
  id: string;
  userId?: string;
  chatId: string;
  text: string;
  parts?: MessagePart[] | null;
  providerState?: string | null;
  timestamp: number;
  generationTime: string;
  modelName: string;
  generatedImages?: PersistedGeneratedImageInput[];
}

export interface PersistedGeneratedImageInput {
  id: string;
  prompt: string;
  imageUrl: string;
  createdAt: number;
  toolCallId?: string | null;
  modelName?: string | null;
  generationTime?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function persistAiResponse(
  input: PersistAiResponseInput,
  db: Kysely<Database>
): Promise<void> {
  await insertAiMessageWithGeneratedImages(
    {
      id: input.id,
      chatId: input.chatId,
      role: 'ai',
      text: input.text,
      parts: input.parts && input.parts.length > 0 ? JSON.stringify(input.parts) : null,
      providerState: input.providerState ?? null,
      timestamp: input.timestamp,
      isGenerating: false,
      generationTime: input.generationTime,
      modelName: input.modelName,
      interactionMode: 'chat',
    },
    input,
    db
  );
}

export interface PersistErrorResponseInput {
  id: string;
  userId?: string;
  chatId: string;
  text: string;
  parts?: MessagePart[] | null;
  timestamp: number;
  generationTime: string;
  modelName: string;
  generatedImages?: PersistedGeneratedImageInput[];
}

export async function persistErrorResponse(
  input: PersistErrorResponseInput,
  db: Kysely<Database>
): Promise<void> {
  await insertAiMessageWithGeneratedImages(
    {
      id: input.id,
      chatId: input.chatId,
      role: 'ai',
      text: input.text,
      parts: input.parts ? JSON.stringify(input.parts) : null,
      timestamp: input.timestamp,
      isGenerating: false,
      generationTime: input.generationTime,
      modelName: input.modelName,
      interactionMode: 'chat',
    },
    input,
    db
  );
}

export async function updateChatAfterTurn(
  chatId: string,
  aiTimestamp: number,
  db: Kysely<Database>
): Promise<void> {
  await db
    .updateTable('chats')
    .set({ updatedAt: aiTimestamp, lastUsedMode: 'chat' })
    .where('id', '=', chatId)
    .where('updatedAt', '<=', aiTimestamp)
    .execute();
}

export interface PersistImageMessageInput {
  userId: string;
  userMsgId: string;
  aiMsgId: string;
  chatId: string;
  prompt: string;
  referenceImageUrl?: string | null;
  generatedImages: Array<{
    id: string;
    imageUrl: string;
    generationTime: string;
    modelName: string;
    createdAt: number;
    toolCallId?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
  styleParams?: string[];
  userTimestamp: number;
  aiTimestamp: number;
}

export async function persistImageTurn(
  input: PersistImageMessageInput,
  db: Kysely<Database>
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await insertMessage(
      {
        id: input.userMsgId,
        chatId: input.chatId,
        role: 'user',
        text: input.prompt,
        referenceImage: input.referenceImageUrl ?? null,
        timestamp: input.userTimestamp,
        isGenerating: false,
        interactionMode: 'image',
      },
      trx
    );

    await insertMessage(
      {
        id: input.aiMsgId,
        chatId: input.chatId,
        role: 'ai',
        text: '',
        imageUrl: input.generatedImages[0]?.imageUrl ?? null,
        timestamp: input.aiTimestamp,
        isGenerating: false,
        generationTime: input.generatedImages[0]?.generationTime ?? null,
        modelName: input.generatedImages[0]?.modelName ?? null,
        styleParams: input.styleParams,
        interactionMode: 'image',
      },
      trx
    );

    for (const generatedImage of input.generatedImages) {
      await insertGeneratedImageArtifact(
        {
          id: generatedImage.id,
          userId: input.userId,
          chatId: input.chatId,
          messageId: input.aiMsgId,
          prompt: input.prompt,
          imageUrl: generatedImage.imageUrl,
          createdAt: generatedImage.createdAt,
          toolCallId: generatedImage.toolCallId ?? null,
          modelName: generatedImage.modelName,
          generationTime: generatedImage.generationTime,
          metadata: generatedImage.metadata ?? null,
        },
        trx
      );
    }

    await trx
      .updateTable('chats')
      .set({ updatedAt: input.aiTimestamp, lastUsedMode: 'image' })
      .where('id', '=', input.chatId)
      .where('updatedAt', '<=', input.aiTimestamp)
      .execute();
  });
}

async function insertAiMessageWithGeneratedImages(
  message: CreateMessageData,
  input: {
    id: string;
    userId?: string;
    chatId: string;
    generatedImages?: PersistedGeneratedImageInput[];
  },
  db: Kysely<Database>
): Promise<void> {
  const generatedImages = input.generatedImages ?? [];
  if (generatedImages.length === 0) {
    await insertMessage(message, db);
    return;
  }

  if (!input.userId) {
    throw new Error('userId is required to persist generated image artifacts.');
  }
  const artifactUserId = input.userId;

  await db.transaction().execute(async (trx) => {
    await insertMessage(message, trx);

    for (const generatedImage of generatedImages) {
      await insertGeneratedImageArtifact(
        {
          id: generatedImage.id,
          userId: artifactUserId,
          chatId: input.chatId,
          messageId: input.id,
          prompt: generatedImage.prompt,
          imageUrl: generatedImage.imageUrl,
          createdAt: generatedImage.createdAt,
          toolCallId: generatedImage.toolCallId ?? null,
          modelName: generatedImage.modelName ?? null,
          generationTime: generatedImage.generationTime ?? null,
          metadata: generatedImage.metadata ?? null,
        },
        trx
      );
    }
  });
}
