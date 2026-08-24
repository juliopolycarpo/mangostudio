import { isAgentId } from '@mangostudio/shared/agents';
import type {
  ChatRunnerConfiguration,
  ChatRunnerPermissions,
  ExternalAgentTargetId,
} from '@mangostudio/shared/chat';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatWithContext } from '@/features/chat/queries';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';

const DEFAULT_AGENT_ID = 'default';
const DEFAULT_RUNNER: ChatRunnerConfiguration = { kind: 'mangostudio', agentId: DEFAULT_AGENT_ID };
/** No choice made. Resolved restrictively server-side, never to a vendor default. */
const EMPTY_PERMISSIONS: ChatRunnerPermissions = {};

interface RunnerSelectionOverride {
  readonly chatId: string | null;
  readonly runner: ChatRunnerConfiguration;
}

interface RunnerPermissionsOverride {
  readonly chatId: string | null;
  readonly permissions: ChatRunnerPermissions;
}

interface UseRunnerSelectionParams {
  readonly currentChatId: string | null;
  readonly currentChat: ChatWithContext | null;
  readonly updateChatRunner: (chatId: string, runner: ChatRunnerConfiguration) => Promise<void>;
  readonly updateChatRunnerPermissions: (
    chatId: string,
    permissions: ChatRunnerPermissions
  ) => Promise<void>;
  readonly defaultWorkdir: string;
  readonly updateChatWorkdir: (chatId: string, workdir: string | null) => Promise<void>;
  readonly addRecentWorkdir: (workdir: string) => void;
}

export function useRunnerSelection({
  currentChatId,
  currentChat,
  updateChatRunner,
  updateChatRunnerPermissions,
  defaultWorkdir,
  updateChatWorkdir,
  addRecentWorkdir,
}: UseRunnerSelectionParams) {
  const [runnerOverride, setRunnerOverride] = useState<RunnerSelectionOverride | null>(null);
  const [permissionsOverride, setPermissionsOverride] = useState<RunnerPermissionsOverride | null>(
    null
  );
  const [isWorkdirPickerOpen, setWorkdirPickerOpen] = useState(false);
  const agentsQuery = useQuery(agentSettingsListQueryOptions());
  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data?.agents]);
  const persistedRunner = currentChat?.runner ?? DEFAULT_RUNNER;
  const activeRunner =
    runnerOverride?.chatId === currentChatId ? runnerOverride.runner : persistedRunner;
  const persistedPermissions = currentChat?.runnerPermissions ?? EMPTY_PERMISSIONS;
  const runnerPermissions =
    permissionsOverride?.chatId === currentChatId
      ? permissionsOverride.permissions
      : persistedPermissions;
  const selectedAgentId = activeRunner.kind === 'mangostudio' ? activeRunner.agentId : null;
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  /**
   * The runner write that has been sent but not yet answered, if any.
   *
   * Held so a send can wait for it. The hub dispatches a turn on the *stored*
   * runner, and this selector writes optimistically, so a turn submitted inside
   * that window would run on the runner the user just replaced.
   */
  const pendingRunnerWrite = useRef<Promise<void> | null>(null);

  const persistRunner = useCallback(
    (runner: ChatRunnerConfiguration) => {
      setRunnerOverride({ chatId: currentChatId, runner });
      if (!currentChatId) return;
      // The override is optimistic, so a rejected write has to take it back:
      // otherwise the picker keeps showing an agent the chat does not store,
      // and turns keep being sent against it.
      const write = updateChatRunner(currentChatId, runner).catch(() => {
        setRunnerOverride((current) =>
          current?.chatId === currentChatId && current.runner === runner ? null : current
        );
      });
      pendingRunnerWrite.current = write;
      void write.finally(() => {
        if (pendingRunnerWrite.current === write) pendingRunnerWrite.current = null;
      });
    },
    [currentChatId, updateChatRunner]
  );

  /**
   * Settles an open runner write before the caller acts on the selection.
   *
   * Free unless a write is actually open, which is only the moment right after
   * the picker was used. This closes the dispatch half of the race — the turn
   * runs on the runner the user chose. The label half survives a *rejected*
   * write: the turn header is already on screen by then, and closing that would
   * take the hub naming the runner it actually used on the wire.
   */
  const whenRunnerPersisted = useCallback(async () => {
    await pendingRunnerWrite.current;
  }, []);

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

  const setRunnerTarget = useCallback(
    (targetId: ExternalAgentTargetId) => {
      persistRunner({ kind: 'external', targetId });
    },
    [persistRunner]
  );

  /**
   * The permission pair, optimistically applied.
   *
   * Local first because the composer chip has to move the moment it is pressed,
   * and reverted on a rejected write for the same reason the runner override is:
   * a control showing a choice the chat does not store would keep sending turns
   * under a permission level the user thinks they changed.
   */
  const setRunnerPermissions = useCallback(
    (permissions: ChatRunnerPermissions) => {
      setPermissionsOverride({ chatId: currentChatId, permissions });
      if (!currentChatId) return;
      void updateChatRunnerPermissions(currentChatId, permissions).catch(() => {
        setPermissionsOverride((current) =>
          current?.chatId === currentChatId && current.permissions === permissions ? null : current
        );
      });
    },
    [currentChatId, updateChatRunnerPermissions]
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
   * The permission pair binds here for the same reason the runner does. A user
   * who set it on the empty state left an override with a null chat id, and the
   * server has no record of it, so without this the very first turn — the one
   * whose permissions are most likely to have been chosen deliberately — runs on
   * the chat defaults instead.
   *
   * Returns the agent selection that was actually bound, rather than leaving
   * the caller to re-read `selectedAgentId` afterwards: that value is a stale
   * closure captured before this awaited call, so it can still show the
   * override this function just reverted after a rejected persist.
   */
  const bindNewChat = useCallback(
    async (chatId: string) => {
      const pendingRunner = runnerOverride?.chatId === null ? runnerOverride.runner : null;
      const pendingPermissions =
        permissionsOverride?.chatId === null ? permissionsOverride.permissions : null;
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

      if (pendingPermissions) {
        setPermissionsOverride({ chatId, permissions: pendingPermissions });
        // Awaited before the caller opens the turn stream, so the hub reads the
        // chosen pair rather than racing the write it was sent alongside.
        await updateChatRunnerPermissions(chatId, pendingPermissions).catch(() => {
          setPermissionsOverride((current) => (current?.chatId === chatId ? null : current));
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
      permissionsOverride,
      runnerAgentSelection,
      runnerOverride,
      updateChatRunner,
      updateChatRunnerPermissions,
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

    // The default is one path with no machine attached: it is picked in Settings
    // against the hub, and `workspaceSettings` has no environment dimension. On
    // another machine it is at best a path that does not exist — a doomed round
    // trip to a runtime that may be a cold SSH dial — and at worst a *different*
    // directory that happens to share the name, which validates and silently
    // binds the chat to the wrong project.
    //
    // Ask instead. The picker browses through the chat, so it lists the
    // machine the chat is actually on. This is also where the failing write
    // already ended up, minus the trip.
    if (!defaultWorkdir || currentChat.environmentId !== LOCAL_ENVIRONMENT_ID) {
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
    runnerPermissions,
    selectedAgentId,
    selectedAgent,
    currentWorkdir: currentChat?.workdir ?? null,
    isWorkdirPickerOpen,
    bindNewChat,
    whenRunnerPersisted,
    setRunnerAgentId,
    setRunnerTarget,
    setRunnerPermissions,
    openWorkdirPicker,
    closeWorkdirPicker,
    selectWorkdir,
  };
}
