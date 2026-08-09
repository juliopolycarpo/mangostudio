import type { ChatAttachment, ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { warmProviderForRequest } from '../../../services/providers/core/provider-readiness';
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import { generateId } from '../../../utils/id';
import { resolveProviderRuntimeAttachments } from '../../attachments/application/runtime-attachment-resolver';
import { assertChatAttachmentIdsAvailable } from '../../attachments/infrastructure/attachment-repository';
import { getOwnedChatOrThrow } from '../../chats/domain/chat-ownership';
import { loadHistory } from '../../messages/infrastructure/message-repository';
import {
  persistAiResponse,
  persistUserMessage,
  updateChatAfterTurn,
} from '../infrastructure/conversation-persistence';
import { resolveModel } from './resolve-model';
import { assertTextTurnHasContent, normalizeTextTurnAttachmentIds } from './text-turn-content';

export class UnsupportedChatRunnerError extends Error {
  constructor(chatId: string) {
    super(
      `Chat ${chatId} is configured with a runner that POST /api/respond does not support. Use /api/respond/stream instead.`
    );
    this.name = 'UnsupportedChatRunnerError';
  }
}

function assertDirectTextRunner(chatId: string, runner: ChatRunnerConfiguration): void {
  if (runner.kind !== 'mangostudio' || runner.agentId !== 'default') {
    throw new UnsupportedChatRunnerError(chatId);
  }
}

export interface SendTextMessageInput {
  chatId: string;
  userId: string;
  prompt: string;
  attachmentIds?: string[];
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
    attachments?: ChatAttachment[];
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
  const chat = await getOwnedChatOrThrow(input.chatId, input.userId, db);
  assertDirectTextRunner(input.chatId, chat.runner);
  const attachmentIds = normalizeTextTurnAttachmentIds(input.attachmentIds);
  assertTextTurnHasContent(input.prompt, attachmentIds);
  await assertChatAttachmentIdsAvailable(
    { attachmentIds, userId: input.userId, chatId: input.chatId },
    db
  );

  const { modelId, capabilities, providerType } = await resolveModel({
    requestedModel: input.model,
    userId: input.userId,
    type: 'text',
  });
  const provider = providerType
    ? getProvider(providerType)
    : await getProviderForModel(modelId, input.userId);
  const warmupPromise = warmProviderForRequest(provider.providerType, {
    userId: input.userId,
    modelName: modelId,
    purpose: 'text',
  });

  const now = Date.now();
  const userMsgId = generateId();

  const attachments = await persistUserMessage(
    {
      id: userMsgId,
      userId: input.userId,
      chatId: input.chatId,
      text: input.prompt,
      attachmentIds,
      timestamp: now,
    },
    db
  );

  const history = await loadHistory(input.chatId, { excludeId: userMsgId }, db);
  const runtimeAttachments = await resolveProviderRuntimeAttachments(
    {
      attachmentIds,
      userId: input.userId,
      chatId: input.chatId,
      messageId: userMsgId,
    },
    db
  );

  const startTime = Date.now();
  await warmupPromise;
  const result = await provider.generateText({
    userId: input.userId,
    environmentId: chat.environmentId,
    chatId: input.chatId,
    history,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    modelName: modelId,
    attachments: runtimeAttachments,
    modelCapabilities: capabilities,
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
      attachments: attachments.length > 0 ? attachments : undefined,
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
