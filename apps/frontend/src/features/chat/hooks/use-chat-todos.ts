import type { ChatTodosResponse, TodoList } from '@mangostudio/shared/todos';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

const chatTodoKeys = {
  all: ['chat-todos'] as const,
  detail: (chatId: string) => [...chatTodoKeys.all, chatId] as const,
};

/** Current todo state for a chat, seeded from the API on chat switch. */
export function useChatTodos(chatId: string | null) {
  return useQuery({
    queryKey: chatTodoKeys.detail(chatId ?? ''),
    queryFn: async () => {
      const { data, error } = await client.api.chats({ id: chatId ?? '' }).todos.get();
      if (error) throw new Error(extractApiError(error.value));
      return data as ChatTodosResponse;
    },
    enabled: !!chatId,
  });
}

/**
 * Writes a streamed `todo_update` payload straight into the query cache so the
 * pinned panel ticks live without a refetch round-trip mid-stream.
 * // Usage: setChatTodos(queryClient, chatId, chunk.todos)
 */
export function setChatTodos(queryClient: QueryClient, chatId: string, todos: TodoList): void {
  queryClient.setQueryData<ChatTodosResponse>(chatTodoKeys.detail(chatId), {
    todos,
    updatedAt: Date.now(),
  });
}
