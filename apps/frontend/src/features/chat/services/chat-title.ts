import type { GenerateChatTitleBody, GenerateChatTitleResponse } from '@mangostudio/shared/chat';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function generateChatTitleSuggestion(
  request: GenerateChatTitleBody
): Promise<GenerateChatTitleResponse> {
  const { data, error } = await client.api.chats['title-suggestion'].post(request);
  if (error) throw new Error(extractApiError(error.value));
  return data as GenerateChatTitleResponse;
}
