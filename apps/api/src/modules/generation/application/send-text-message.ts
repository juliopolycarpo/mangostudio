import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
import { resolveModel } from './resolve-model';
import { loadHistory } from '../../messages/infrastructure/message-repository';
import { getProviderForModel } from '../../../services/providers/registry';
import { generateId } from '../../../utils/id';
import {
  persistUserMessage,
  persistAiResponse,
  updateChatAfterTurn,
} from '../infrastructure/conversation-persistence';

export interface SendTextMessageInput {
  chatId: string;
  userId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
}

export interface SendTextMessageResult {
  userMessage: {
    id: string;
    chatId: string;
    role: 'user';
    text: string;
    timestamp: number;
    isGenerating: boolean;
    interactionMode: 'chat';
  };
  aiMessage: {
    id: string;
    chatId: string;
    role: 'ai';
    text: string;
    timestamp: number;
    isGenerating: boolean;
    generationTime: string;
    modelName: string;
    interactionMode: 'chat';
  };
}

export async function sendTextMessage(
  input: SendTextMessageInput,
  db: Kysely<Database>
): Promise<SendTextMessageResult> {
  await assertChatOwnership(input.chatId, input.userId, db);

  const { modelId } = await resolveModel({
    requestedModel: input.model,
    userId: input.userId,
    type: 'text',
  });

  const now = Date.now();
  const userMsgId = generateId();

  await persistUserMessage(
    { id: userMsgId, chatId: input.chatId, text: input.prompt, timestamp: now },
    db
  );

  const history = await loadHistory(input.chatId, { excludeId: userMsgId }, db);

  const provider = await getProviderForModel(modelId, input.userId);
  const startTime = Date.now();
  const result = await provider.generateText({
    userId: input.userId,
    history,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    modelName: modelId,
  });

  const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  const aiTimestamp = Date.now();
  const aiMsgId = generateId();

  await persistAiResponse(
    {
      id: aiMsgId,
      chatId: input.chatId,
      text: result.text,
      timestamp: aiTimestamp,
      generationTime,
      modelName: modelId,
    },
    db
  );

  await updateChatAfterTurn(input.chatId, aiTimestamp, db);

  return {
    userMessage: {
      id: userMsgId,
      chatId: input.chatId,
      role: 'user',
      text: input.prompt,
      timestamp: now,
      isGenerating: false,
      interactionMode: 'chat',
    },
    aiMessage: {
      id: aiMsgId,
      chatId: input.chatId,
      role: 'ai',
      text: result.text,
      timestamp: aiTimestamp,
      isGenerating: false,
      generationTime,
      modelName: modelId,
      interactionMode: 'chat',
    },
  };
}
