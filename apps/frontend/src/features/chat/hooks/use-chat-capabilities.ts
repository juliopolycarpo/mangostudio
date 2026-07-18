/**
 * Chat capability inspector query. The effective capability set is resolved
 * server-side by the same runtime resolver generation uses — the frontend
 * only renders the projection, never re-derives eligibility.
 */

import { type AgentExecutionMode, isAgentId } from '@mangostudio/shared/agents';
import type { ChatCapabilitiesResponse } from '@mangostudio/shared/capabilities';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export interface ChatCapabilitiesSelection {
  readonly chatId: string;
  readonly model?: string;
  readonly agentMode?: AgentExecutionMode;
  readonly agentId?: string;
}

const chatCapabilitiesKeys = {
  all: ['chat-capabilities'] as const,
  selection: (selection: ChatCapabilitiesSelection) =>
    [
      ...chatCapabilitiesKeys.all,
      selection.chatId,
      selection.model ?? null,
      selection.agentMode ?? 'chat',
      selection.agentId ?? null,
    ] as const,
};

/** Marks every cached capability projection stale after a runtime input changes. */
export function invalidateChatCapabilities(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: chatCapabilitiesKeys.all });
}

export function chatCapabilitiesQueryOptions(selection: ChatCapabilitiesSelection) {
  return queryOptions({
    queryKey: chatCapabilitiesKeys.selection(selection),
    // Invalidation covers in-app mutations. Keep a short freshness window for
    // external changes without relisting MCP tools on every popover open.
    staleTime: 30_000,
    queryFn: async () => {
      const agentId =
        selection.agentMode === 'agent' && selection.agentId && isAgentId(selection.agentId)
          ? selection.agentId
          : undefined;
      const { data, error } = await client.api.chats({ id: selection.chatId }).capabilities.get({
        query: {
          ...(selection.model ? { model: selection.model } : {}),
          ...(selection.agentMode ? { agentMode: selection.agentMode } : {}),
          ...(agentId ? { agentId } : {}),
        },
      });
      if (error) throw new Error(extractApiError(error.value));
      return data as ChatCapabilitiesResponse;
    },
  });
}
