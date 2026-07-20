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
  readonly defaultWorkdir: string;
  readonly updateChatWorkdir: (chatId: string, workdir: string | null) => Promise<void>;
  readonly addRecentWorkdir: (workdir: string) => void;
}

export function useAgentSelection({
  currentChatId,
  currentChat,
  updateChatAgentSelection,
  defaultWorkdir,
  updateChatWorkdir,
  addRecentWorkdir,
}: UseAgentSelectionParams) {
  const [agentSelectionOverride, setAgentSelectionOverride] =
    useState<AgentSelectionOverride | null>(null);
  const [isWorkdirPickerOpen, setWorkdirPickerOpen] = useState(false);
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
      if (mode !== 'agent' || !currentChatId || currentChat?.workdir) return;
      if (!defaultWorkdir) {
        setWorkdirPickerOpen(true);
        return;
      }

      void updateChatWorkdir(currentChatId, defaultWorkdir)
        .then(() => addRecentWorkdir(defaultWorkdir))
        .catch(() => setWorkdirPickerOpen(true));
    },
    [
      addRecentWorkdir,
      currentChat?.workdir,
      currentChatId,
      defaultWorkdir,
      persistAgentSelection,
      selectedAgentId,
      updateChatWorkdir,
    ]
  );

  const setSelectedAgentId = useCallback(
    (agentId: string) => {
      persistAgentSelection('agent', agentId);
    },
    [persistAgentSelection]
  );

  const openWorkdirPicker = useCallback(() => setWorkdirPickerOpen(true), []);
  const closeWorkdirPicker = useCallback(() => setWorkdirPickerOpen(false), []);
  const selectWorkdir = useCallback(
    async (workdir: string) => {
      if (!currentChatId) return;
      await updateChatWorkdir(currentChatId, workdir);
      addRecentWorkdir(workdir);
      setWorkdirPickerOpen(false);
    },
    [addRecentWorkdir, currentChatId, updateChatWorkdir]
  );

  return {
    agents,
    isAgentListLoading: agentsQuery.isLoading,
    agentExecutionMode,
    selectedAgentId,
    selectedAgent,
    currentWorkdir: currentChat?.workdir ?? null,
    isWorkdirPickerOpen,
    setAgentExecutionMode,
    setSelectedAgentId,
    openWorkdirPicker,
    closeWorkdirPicker,
    selectWorkdir,
  };
}
