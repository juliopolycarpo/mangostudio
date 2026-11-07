import type { ChatAttachment, ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { InteractionMode, MessagePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { linkAttachmentsToMessage } from '../../attachments/infrastructure/attachment-repository';
import { insertGeneratedImageArtifact } from '../../generated-images/infrastructure/generated-image-repository';
import {
  type CreateMessageData,
  insertMessage,
} from '../../messages/infrastructure/message-repository';

const logger = createDiagnosticLogger('conversation-persistence');

type RunnerKind = ChatRunnerConfiguration['kind'];

// Keep the kind check in the same SQLite transaction as the first message.
// A concurrent kind change must either commit first or see the new transcript.
async function assertCurrentRunnerKind(
  chatId: string,
  userId: string,
  expected: RunnerKind,
  db: Kysely<Database>
): Promise<void> {
  const chat = await db
    .selectFrom('chats')
    .select('runnerKind')
    .where('id', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (chat?.runnerKind !== expected) {
    throw new Error(
      `Expected chat ${chatId} runner kind ${expected}, received ${chat?.runnerKind ?? 'missing chat'}.`
    );
  }
}

export interface PersistUserMessageInput {
  id: string;
  userId?: string;
  admittedRunnerKind?: RunnerKind;
  chatId: string;
  text: string;
  attachmentIds?: string[];
  timestamp: number;
  interactionMode?: InteractionMode;
}

export async function persistUserMessage(
  input: PersistUserMessageInput,
  db: Kysely<Database>
): Promise<ChatAttachment[]> {
  const message: CreateMessageData = {
    id: input.id,
    chatId: input.chatId,
    role: 'user',
    text: input.text,
    timestamp: input.timestamp,
    isGenerating: false,
    interactionMode: input.interactionMode ?? 'chat',
  };
  const attachmentIds = input.attachmentIds ?? [];

  if (attachmentIds.length === 0 && !input.admittedRunnerKind) {
    await insertMessage(message, db);
    return [];
  }

  if (!input.userId) {
    throw new Error('userId is required to bind a runner or attach files to a user message.');
  }
  const userId = input.userId;

  return db.transaction().execute(async (trx) => {
    if (input.admittedRunnerKind) {
      await assertCurrentRunnerKind(input.chatId, userId, input.admittedRunnerKind, trx);
    }
    await insertMessage(message, trx);
    if (attachmentIds.length === 0) return [];
    return linkAttachmentsToMessage(
      {
        attachmentIds,
        userId,
        chatId: input.chatId,
        messageId: input.id,
        updatedAt: input.timestamp,
      },
      trx
    );
  });
}

export interface PersistTextTurnStartInput {
  userId: string;
  admittedRunnerKind?: RunnerKind;
  userMessageId: string;
  assistantMessageId: string;
  chatId: string;
  displayPrompt: string;
  attachmentIds?: string[];
  timestamp: number;
  interactionMode: Exclude<InteractionMode, 'image'>;
  modelName: string;
  assistantParts: MessagePart[];
}

/** Inserts the user message and durable assistant placeholder atomically. */
export function persistTextTurnStart(
  input: PersistTextTurnStartInput,
  db: Kysely<Database>
): Promise<ChatAttachment[]> {
  return db.transaction().execute(async (trx) => {
    if (input.admittedRunnerKind) {
      await assertCurrentRunnerKind(input.chatId, input.userId, input.admittedRunnerKind, trx);
    }
    await insertMessage(
      {
        id: input.userMessageId,
        chatId: input.chatId,
        role: 'user',
        text: input.displayPrompt,
        timestamp: input.timestamp,
        isGenerating: false,
        interactionMode: input.interactionMode,
      },
      trx
    );

    const attachmentIds = input.attachmentIds ?? [];
    const attachments =
      attachmentIds.length > 0
        ? await linkAttachmentsToMessage(
            {
              attachmentIds,
              userId: input.userId,
              chatId: input.chatId,
              messageId: input.userMessageId,
              updatedAt: input.timestamp,
            },
            trx
          )
        : [];

    await insertMessage(
      {
        id: input.assistantMessageId,
        chatId: input.chatId,
        role: 'ai',
        text: '',
        timestamp: input.timestamp + 1,
        isGenerating: true,
        modelName: input.modelName,
        interactionMode: input.interactionMode,
        parts: JSON.stringify(input.assistantParts),
      },
      trx
    );

    return attachments;
  });
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
  interactionMode?: InteractionMode;
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
      interactionMode: input.interactionMode ?? 'chat',
    },
    input,
    db
  );
}

export interface FinalizeCheckpointedAiResponseInput {
  id: string;
  userId: string;
  chatId: string;
  text: string;
  parts: MessagePart[];
  providerState?: string | null;
  generationTime: string;
  modelName: string;
  generatedImages?: PersistedGeneratedImageInput[];
}

/**
 * Finalizes the existing assistant placeholder and its image artifacts in one
 * transaction. The `isGenerating` guard makes the first terminal writer win.
 */
export function finalizeCheckpointedAiResponse(
  input: FinalizeCheckpointedAiResponseInput,
  db: Kysely<Database>
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('messages')
      .set({
        text: input.text,
        parts: JSON.stringify(input.parts),
        providerState: input.providerState ?? null,
        isGenerating: 0,
        generationTime: input.generationTime,
        modelName: input.modelName,
      })
      .where('id', '=', input.id)
      .where('isGenerating', '=', 1)
      .executeTakeFirst();

    if (result.numUpdatedRows === 0n) return false;

    for (const generatedImage of input.generatedImages ?? []) {
      await insertGeneratedImageArtifact(
        {
          id: generatedImage.id,
          userId: input.userId,
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

    return true;
  });
}

/**
 * Move a chat up in recent activity. Use `{ bestEffort: true }` once a keyed turn's
 * verdict is durable, so a recency write failure cannot replace that verdict.
 *
 * @example await updateChatAfterTurn(chatId, finishedAt, db, { bestEffort: true });
 */
export async function updateChatAfterTurn(
  chatId: string,
  aiTimestamp: number,
  db: Kysely<Database>,
  { bestEffort = false } = {}
): Promise<void> {
  try {
    await db
      .updateTable('chats')
      .set({ updatedAt: aiTimestamp })
      .where('id', '=', chatId)
      .where('updatedAt', '<=', aiTimestamp)
      .execute();
  } catch (error) {
    if (!bestEffort) throw error;
    logger.warn('chat_recency_update_failed', { chatId, error: String(error) });
  }
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
      .set({ updatedAt: input.aiTimestamp })
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
