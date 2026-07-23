import type { ChatFileCheckpointsResponse } from '@mangostudio/shared/file-checkpoints';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const chatFileCheckpointKeys = {
  all: ['chat-file-checkpoints'] as const,
  detail: (chatId: string) => [...chatFileCheckpointKeys.all, chatId] as const,
};

export function useChatFileCheckpoints(chatId: string | null) {
  return useQuery({
    queryKey: chatFileCheckpointKeys.detail(chatId ?? ''),
    queryFn: async () => {
      const { data, error } = await client.api.chats({ id: chatId ?? '' }).checkpoints.get();
      if (error) throw new ApiError(error.value);
      return data as ChatFileCheckpointsResponse;
    },
    enabled: !!chatId,
  });
}

export function useRevertChatFileCheckpoints(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const { data, error } = await client.api
        .chats({ id: chatId ?? '' })
        .checkpoints({ messageId })
        .revert.post();
      if (error) throw new ApiError(error.value);
      return data;
    },
    onSuccess: () => {
      if (chatId) {
        void queryClient.invalidateQueries({ queryKey: chatFileCheckpointKeys.detail(chatId) });
      }
    },
  });
}

export function invalidateChatFileCheckpoints(
  queryClient: ReturnType<typeof useQueryClient>,
  chatId: string
): void {
  void queryClient.invalidateQueries({ queryKey: chatFileCheckpointKeys.detail(chatId) });
}
