import type { AgentExecutionMode } from '@mangostudio/shared/agents';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { ChatWithContext } from '@/features/chat/queries';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';

interface AgentSelectionOverride {
  readonly chatId: string | null;
  readonly mode: AgentExecutionMode;
  readonly agentId: string;
}

interface PersistAgentSelectionUpdates {
  readonly lastUsedMode: 'chat' | 'agent';
  readonly selectedAgentId?: string;
}

interface UseAgentSelectionParams {
  readonly currentChatId: string | null;
  readonly currentChat: ChatWithContext | null;
  readonly updateChatAgentSelection: (
    chatId: string,
    updates: PersistAgentSelectionUpdates
  ) => Promise<void>;
}

export function useAgentSelection({
  currentChatId,
  currentChat,
  updateChatAgentSelection,
}: UseAgentSelectionParams) {
  const [agentSelectionOverride, setAgentSelectionOverride] =
    useState<AgentSelectionOverride | null>(null);
  const agentsQuery = useQuery(agentSettingsListQueryOptions());
  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data?.agents]);
  const persistedAgentSelection = useMemo(
    () => ({
      mode: currentChat?.lastUsedMode === 'agent' ? ('agent' as const) : ('chat' as const),
      agentId: currentChat?.selectedAgentId ?? 'default',
    }),
    [currentChat?.lastUsedMode, currentChat?.selectedAgentId]
  );
  const activeAgentSelection =
    agentSelectionOverride?.chatId === currentChatId
      ? agentSelectionOverride
      : persistedAgentSelection;
  const agentExecutionMode = activeAgentSelection.mode;
  const selectedAgentId = activeAgentSelection.agentId;
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  const persistAgentSelection = useCallback(
    (mode: AgentExecutionMode, agentId: string) => {
      setAgentSelectionOverride({ chatId: currentChatId, mode, agentId });
      if (!currentChatId) return;
      void updateChatAgentSelection(currentChatId, {
        lastUsedMode: mode,
        selectedAgentId: mode === 'agent' ? agentId : 'chat',
      });
    },
    [currentChatId, updateChatAgentSelection]
  );

  const setAgentExecutionMode = useCallback(
    (mode: AgentExecutionMode) => {
      const nextAgentId = mode === 'agent' ? selectedAgentId || 'default' : 'chat';
      persistAgentSelection(mode, nextAgentId);
    },
    [persistAgentSelection, selectedAgentId]
  );

  const setSelectedAgentId = useCallback(
    (agentId: string) => {
      persistAgentSelection('agent', agentId);
    },
    [persistAgentSelection]
  );

  return {
    agents,
    isAgentListLoading: agentsQuery.isLoading,
    agentExecutionMode,
    selectedAgentId,
    selectedAgent,
    setAgentExecutionMode,
    setSelectedAgentId,
  };
}
