import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { GeneratedImageArtifact } from '@mangostudio/shared';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
import { resolveModel } from './resolve-model';
import { getProviderForModel } from '../../../services/providers/core/provider-registry';
import { warmProviderForRequest } from '../../../services/providers/core/provider-readiness';
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
    generatedImages: GeneratedImageArtifact[];
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
  const warmupPromise = warmProviderForRequest(provider.providerType, {
    userId: input.userId,
    modelName: modelId,
    purpose: 'image',
  });

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

  await warmupPromise;
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
  const generatedImages: GeneratedImageArtifact[] = [
    {
      id: generateId(),
      chatId: input.chatId,
      messageId: aiMsgId,
      prompt: input.prompt,
      imageUrl,
      createdAt: aiTimestamp,
      modelName: modelId,
      generationTime,
    },
  ];

  await persistImageTurn(
    {
      userId: input.userId,
      userMsgId,
      aiMsgId,
      chatId: input.chatId,
      prompt: input.prompt,
      referenceImageUrl: input.referenceImageUrl,
      generatedImages: generatedImages.map((generatedImage) => ({
        id: generatedImage.id,
        imageUrl: generatedImage.imageUrl,
        generationTime: generatedImage.generationTime ?? generationTime,
        modelName: generatedImage.modelName ?? modelId,
        createdAt: generatedImage.createdAt,
      })),
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
      generatedImages,
      timestamp: aiTimestamp,
      isGenerating: false,
      generationTime,
      modelName: modelId,
      styleParams,
    },
  };
}
