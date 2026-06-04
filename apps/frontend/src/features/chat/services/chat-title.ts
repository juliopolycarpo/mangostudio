import type { GenerateChatTitleBody, GenerateChatTitleResponse } from '@mangostudio/shared/chat';
import { en } from '@mangostudio/shared/i18n';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function generateChatTitleSuggestion(
  request: GenerateChatTitleBody
): Promise<GenerateChatTitleResponse> {
  const { data, error } = await client.api.chats['title-suggestion'].post(request);
  if (error) throw new Error(extractApiError(error.value, en.chat.titleGenerationFailed));
  return data as GenerateChatTitleResponse;
}
