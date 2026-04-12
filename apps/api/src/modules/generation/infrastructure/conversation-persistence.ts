import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { MessagePart } from '@mangostudio/shared/types';
import { insertMessage } from '../../messages/infrastructure/message-repository';

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
  chatId: string;
  text: string;
  parts?: MessagePart[] | null;
  providerState?: string | null;
  timestamp: number;
  generationTime: string;
  modelName: string;
}

export async function persistAiResponse(
  input: PersistAiResponseInput,
  db: Kysely<Database>
): Promise<void> {
  await insertMessage(
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
    db
  );
}

export interface PersistErrorResponseInput {
  id: string;
  chatId: string;
  text: string;
  parts?: MessagePart[] | null;
  timestamp: number;
  generationTime: string;
  modelName: string;
}

export async function persistErrorResponse(
  input: PersistErrorResponseInput,
  db: Kysely<Database>
): Promise<void> {
  await insertMessage(
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
  userMsgId: string;
  aiMsgId: string;
  chatId: string;
  prompt: string;
  referenceImageUrl?: string | null;
  imageUrl: string;
  generationTime: string;
  modelName: string;
  styleParams?: string[];
  userTimestamp: number;
  aiTimestamp: number;
}

export async function persistImageTurn(
  input: PersistImageMessageInput,
  db: Kysely<Database>
): Promise<void> {
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
    db
  );

  await insertMessage(
    {
      id: input.aiMsgId,
      chatId: input.chatId,
      role: 'ai',
      text: '',
      imageUrl: input.imageUrl,
      timestamp: input.aiTimestamp,
      isGenerating: false,
      generationTime: input.generationTime,
      modelName: input.modelName,
      styleParams: input.styleParams,
      interactionMode: 'image',
    },
    db
  );

  await db
    .updateTable('chats')
    .set({ updatedAt: input.aiTimestamp, lastUsedMode: 'image' })
    .where('id', '=', input.chatId)
    .where('updatedAt', '<=', input.aiTimestamp)
    .execute();
}
