import { isAgentId } from '@mangostudio/shared/agents';
import type { ChatRunnerConfiguration, ExternalAgentTargetId } from '@mangostudio/shared/chat';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatWithContext } from '@/features/chat/queries';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';

const DEFAULT_RUNNER: ChatRunnerConfiguration = { kind: 'mangostudio', agentId: 'default' };

interface RunnerSelectionOverride {
  readonly chatId: string | null;
  readonly runner: ChatRunnerConfiguration;
}

interface UseRunnerSelectionParams {
  readonly currentChatId: string | null;
  readonly currentChat: ChatWithContext | null;
  readonly updateChatRunner: (chatId: string, runner: ChatRunnerConfiguration) => Promise<void>;
  readonly defaultWorkdir: string;
  readonly updateChatWorkdir: (chatId: string, workdir: string | null) => Promise<void>;
  readonly addRecentWorkdir: (workdir: string) => void;
}

export function useRunnerSelection({
  currentChatId,
  currentChat,
  updateChatRunner,
  defaultWorkdir,
  updateChatWorkdir,
  addRecentWorkdir,
}: UseRunnerSelectionParams) {
  const [runnerOverride, setRunnerOverride] = useState<RunnerSelectionOverride | null>(null);
  const [isWorkdirPickerOpen, setWorkdirPickerOpen] = useState(false);
  const agentsQuery = useQuery(agentSettingsListQueryOptions());
  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data?.agents]);
  const persistedRunner = currentChat?.runner ?? DEFAULT_RUNNER;
  const activeRunner =
    runnerOverride?.chatId === currentChatId ? runnerOverride.runner : persistedRunner;
  const selectedAgentId = activeRunner.kind === 'mangostudio' ? activeRunner.agentId : null;
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  const persistRunner = useCallback(
    (runner: ChatRunnerConfiguration) => {
      setRunnerOverride({ chatId: currentChatId, runner });
      if (!currentChatId) return;
      void updateChatRunner(currentChatId, runner);
    },
    [currentChatId, updateChatRunner]
  );

  const setRunnerAgentId = useCallback(
    (agentId: string) => {
      persistRunner({ kind: 'mangostudio', agentId: isAgentId(agentId) ? agentId : 'default' });
    },
    [persistRunner]
  );

  // No external adapter exists yet; kept as a stub the runner selector can
  // wire up once one does.
  const setRunnerTarget = useCallback((_targetId: ExternalAgentTargetId) => {
    // Intentionally a no-op until an external-agent adapter is reachable.
  }, []);

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

  // Every chat carries a runner from creation, so the workdir default fires
  // once per chat the first time it is observed without one, rather than on
  // a mode switch that no longer exists.
  const workdirDefaultedChatIds = useRef(new Set<string>());
  useEffect(() => {
    if (!currentChatId || currentChat?.workdir) return;
    if (workdirDefaultedChatIds.current.has(currentChatId)) return;
    workdirDefaultedChatIds.current.add(currentChatId);

    if (!defaultWorkdir) {
      setWorkdirPickerOpen(true);
      return;
    }

    void updateChatWorkdir(currentChatId, defaultWorkdir)
      .then(() => addRecentWorkdir(defaultWorkdir))
      .catch(() => setWorkdirPickerOpen(true));
  }, [addRecentWorkdir, currentChat?.workdir, currentChatId, defaultWorkdir, updateChatWorkdir]);

  return {
    agents,
    isAgentListLoading: agentsQuery.isLoading,
    runner: activeRunner,
    selectedAgentId,
    selectedAgent,
    currentWorkdir: currentChat?.workdir ?? null,
    isWorkdirPickerOpen,
    setRunnerAgentId,
    setRunnerTarget,
    openWorkdirPicker,
    closeWorkdirPicker,
    selectWorkdir,
  };
}
