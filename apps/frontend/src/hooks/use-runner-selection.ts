import { isAgentId } from '@mangostudio/shared/agents';
import type { ChatRunnerConfiguration, ExternalAgentTargetId } from '@mangostudio/shared/chat';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatWithContext } from '@/features/chat/queries';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';

const DEFAULT_AGENT_ID = 'default';
const DEFAULT_RUNNER: ChatRunnerConfiguration = { kind: 'mangostudio', agentId: DEFAULT_AGENT_ID };

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
      // The override is optimistic, so a rejected write has to take it back:
      // otherwise the picker keeps showing an agent the chat does not store,
      // and turns keep being sent against it.
      void updateChatRunner(currentChatId, runner).catch(() => {
        setRunnerOverride((current) =>
          current?.chatId === currentChatId && current.runner === runner ? null : current
        );
      });
    },
    [currentChatId, updateChatRunner]
  );

  const runnerAgentSelection = useCallback(
    (runner: ChatRunnerConfiguration) => {
      const agentId = runner.kind === 'mangostudio' ? runner.agentId : DEFAULT_AGENT_ID;
      return { agentId, agentName: agents.find((agent) => agent.id === agentId)?.name };
    },
    [agents]
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

  /**
   * Binds a chat that was just created mid-submit, before its first turn opens.
   *
   * Neither of the two paths below can cover this window: `persistRunner` had
   * no chat id to write to when the picker was used on the empty state, and the
   * workdir effect cannot fire until React has observed the new record — by
   * which time generation has already started. Left alone, the first turn runs
   * against the server's `default` runner with no workdir, so a configured
   * `restrictToolsToWorkdir` has nothing to contain.
   *
   * Returns the agent selection that was actually bound, rather than leaving
   * the caller to re-read `selectedAgentId` afterwards: that value is a stale
   * closure captured before this awaited call, so it can still show the
   * override this function just reverted after a rejected persist.
   */
  const bindNewChat = useCallback(
    async (chatId: string) => {
      const pendingRunner = runnerOverride?.chatId === null ? runnerOverride.runner : null;
      let effectiveRunner: ChatRunnerConfiguration = DEFAULT_RUNNER;
      if (pendingRunner) {
        setRunnerOverride({ chatId, runner: pendingRunner });
        effectiveRunner = await updateChatRunner(chatId, pendingRunner)
          .then(() => pendingRunner)
          .catch(() => {
            setRunnerOverride((current) => (current?.chatId === chatId ? null : current));
            return DEFAULT_RUNNER;
          });
      }

      if (!workdirDefaultedChatIds.current.has(chatId)) {
        workdirDefaultedChatIds.current.add(chatId);
        if (!defaultWorkdir) {
          setWorkdirPickerOpen(true);
        } else {
          await updateChatWorkdir(chatId, defaultWorkdir)
            .then(() => addRecentWorkdir(defaultWorkdir))
            .catch(() => setWorkdirPickerOpen(true));
        }
      }

      return runnerAgentSelection(effectiveRunner);
    },
    [
      addRecentWorkdir,
      defaultWorkdir,
      runnerAgentSelection,
      runnerOverride,
      updateChatRunner,
      updateChatWorkdir,
    ]
  );

  useEffect(() => {
    // A selected chat has an id before its record arrives, and a missing
    // record is indistinguishable from a null workdir. Acting on that window
    // would write the default over whatever the server actually has — and,
    // because the id is then marked as defaulted, never retry.
    if (!currentChatId || !currentChat || currentChat.workdir) return;
    if (workdirDefaultedChatIds.current.has(currentChatId)) return;
    workdirDefaultedChatIds.current.add(currentChatId);

    if (!defaultWorkdir) {
      setWorkdirPickerOpen(true);
      return;
    }

    void updateChatWorkdir(currentChatId, defaultWorkdir)
      .then(() => addRecentWorkdir(defaultWorkdir))
      .catch(() => setWorkdirPickerOpen(true));
  }, [addRecentWorkdir, currentChat, currentChatId, defaultWorkdir, updateChatWorkdir]);

  return {
    agents,
    isAgentListLoading: agentsQuery.isLoading,
    runner: activeRunner,
    selectedAgentId,
    selectedAgent,
    currentWorkdir: currentChat?.workdir ?? null,
    isWorkdirPickerOpen,
    bindNewChat,
    setRunnerAgentId,
    setRunnerTarget,
    openWorkdirPicker,
    closeWorkdirPicker,
    selectWorkdir,
  };
}
