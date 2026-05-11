import {
  createPromptChatTitle,
  sanitizeGeneratedChatTitle,
  type GenerateChatTitleResponse,
} from '@mangostudio/shared/chat';
import { getProviderForModel } from '../../../services/providers/core/provider-registry';
import { warmProviderForRequest } from '../../../services/providers/core/provider-readiness';
import { resolveModel } from '../../generation/application/resolve-model';

const CHAT_TITLE_SYSTEM_PROMPT =
  'Create a concise chat title from the user prompt. Return only the title, without quotes or punctuation wrappers.';
const CHAT_TITLE_PROMPT_PREFIX = 'User prompt:';
const CHAT_TITLE_MAX_OUTPUT_TOKENS = 32;

export class EmptyChatTitlePromptError extends Error {
  constructor() {
    super('A prompt is required to generate a chat title.');
    this.name = 'EmptyChatTitlePromptError';
  }
}

export interface GenerateChatTitleInput {
  userId: string;
  prompt: string;
  model: string;
}

export async function generateChatTitleUseCase(
  input: GenerateChatTitleInput
): Promise<GenerateChatTitleResponse> {
  const fallbackTitle = createPromptChatTitle(input.prompt);
  if (!fallbackTitle) throw new EmptyChatTitlePromptError();

  const { modelId, capabilities } = await resolveModel({
    requestedModel: input.model,
    userId: input.userId,
    type: 'text',
  });
  const provider = await getProviderForModel(modelId, input.userId);
  await warmProviderForRequest(provider.providerType, {
    userId: input.userId,
    modelName: modelId,
    purpose: 'text',
  });
  const result = await provider.generateText({
    userId: input.userId,
    history: [],
    prompt: `${CHAT_TITLE_PROMPT_PREFIX}\n${input.prompt}`,
    systemPrompt: CHAT_TITLE_SYSTEM_PROMPT,
    modelName: modelId,
    modelCapabilities: capabilities,
    generationConfig: {
      thinkingEnabled: false,
      reasoningEffort: 'low',
      maxOutputTokens: CHAT_TITLE_MAX_OUTPUT_TOKENS,
    },
  });

  return { title: sanitizeGeneratedChatTitle(result.text, fallbackTitle) };
}
