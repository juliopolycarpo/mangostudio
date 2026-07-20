import type {
  CompactChatBody,
  ContextCompactionResponse,
  SummarizeToNewChatBody,
} from '@mangostudio/shared/chat';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export async function compactChat(
  chatId: string,
  body: CompactChatBody
): Promise<ContextCompactionResponse> {
  const { data, error } = await client.api.chats({ id: chatId }).compact.post(body);
  if (error) throw new ApiError(error.value);
  return data as ContextCompactionResponse;
}

export async function summarizeToNewChat(
  chatId: string,
  body: SummarizeToNewChatBody
): Promise<ContextCompactionResponse> {
  const { data, error } = await client.api
    .chats({ id: chatId })
    ['summarize-to-new-chat'].post(body);
  if (error) throw new ApiError(error.value);
  return data as ContextCompactionResponse;
}
