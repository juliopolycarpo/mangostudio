import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
import { resolveModel } from './resolve-model';
import { getProviderForModel } from '../../../services/providers/registry';
import { generateId } from '../../../utils/id';
import { persistImageTurn } from '../infrastructure/conversation-persistence';
import { composePrompt } from '../../prompt-rules/application/prompt-composer';

export interface GenerateImageInput {
  chatId: string;
  userId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  promptSettings?: PromptSettings;
  referenceImageUrl?: string;
  imageQuality?: string;
}

export interface GenerateImageResult {
  userMessage: {
    id: string;
    chatId: string;
    role: 'user';
    text: string;
    referenceImage?: string;
    timestamp: number;
    isGenerating: boolean;
  };
  aiMessage: {
    id: string;
    chatId: string;
    role: 'ai';
    text: string;
    imageUrl: string;
    timestamp: number;
    isGenerating: boolean;
    generationTime: string;
    modelName: string;
    styleParams: string[];
  };
}

export class ImageProviderNotSupportedError extends Error {
  constructor() {
    super('This provider does not support image generation.');
    this.name = 'ImageProviderNotSupportedError';
  }
}

export async function generateImage(
  input: GenerateImageInput,
  db: Kysely<Database>
): Promise<GenerateImageResult> {
  await assertChatOwnership(input.chatId, input.userId, db);

  const { modelId } = await resolveModel({
    requestedModel: input.model,
    userId: input.userId,
    type: 'image',
  });

  const provider = await getProviderForModel(modelId, input.userId);
  if (!provider.generateImage) {
    throw new ImageProviderNotSupportedError();
  }

  const now = Date.now();
  const userMsgId = generateId();
  const aiMsgId = generateId();
  const startTime = Date.now();

  const priorUserMsg = await db
    .selectFrom('messages')
    .select('id')
    .where('chatId', '=', input.chatId)
    .where('role', '=', 'user')
    .limit(1)
    .executeTakeFirst();
  const isFirstTurn = !priorUserMsg;

  const composition = composePrompt({
    settings: input.promptSettings,
    baseSystemPrompt: input.systemPrompt ?? '',
    visiblePrompt: input.prompt,
    isFirstTurn,
  });

  const { imageUrl } = await provider.generateImage({
    userId: input.userId,
    prompt: composition.effectivePrompt,
    systemPrompt: composition.effectiveSystemPrompt || undefined,
    referenceImageUrl: input.referenceImageUrl,
    imageSize: input.imageQuality ?? '1K',
    modelName: modelId,
  });

  const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  const styleParams = [input.imageQuality ?? '1K'];
  const aiTimestamp = Date.now();

  await persistImageTurn(
    {
      userMsgId,
      aiMsgId,
      chatId: input.chatId,
      prompt: input.prompt,
      referenceImageUrl: input.referenceImageUrl,
      imageUrl,
      generationTime,
      modelName: modelId,
      styleParams,
      userTimestamp: now,
      aiTimestamp,
    },
    db
  );

  return {
    userMessage: {
      id: userMsgId,
      chatId: input.chatId,
      role: 'user',
      text: input.prompt,
      referenceImage: input.referenceImageUrl,
      timestamp: now,
      isGenerating: false,
    },
    aiMessage: {
      id: aiMsgId,
      chatId: input.chatId,
      role: 'ai',
      text: '',
      imageUrl,
      timestamp: aiTimestamp,
      isGenerating: false,
      generationTime,
      modelName: modelId,
      styleParams,
    },
  };
}
