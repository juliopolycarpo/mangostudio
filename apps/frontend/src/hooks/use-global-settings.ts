import type { ReasoningEffort } from '@mangostudio/shared';
import type { ChatDisplaySettings, DiffPreviewMode } from '@mangostudio/shared/app-settings';
import {
  type AppSettings,
  type ChatTitleSettings,
  type ChatTitleStrategy,
  clampMaxToolIterations,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PROMPT_SETTINGS,
  type ImageQuality,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  type MultiAgentSettings,
  normalizeAppSettings,
  normalizeChatTitleSettings,
} from '@mangostudio/shared/app-settings';
import type { ContextCompactionBehavior, ContextSettings } from '@mangostudio/shared/chat';
import { DEFAULT_COMMIT_MESSAGE_PROMPT } from '@mangostudio/shared/git';
import type { RuleFileSetting } from '@mangostudio/shared/prompt-rules';
import {
  RECENT_WORKDIRS_MAX,
  type WorkspacePanelId,
  type WorkspacePanelSettings,
  type WorkspaceSettings,
} from '@mangostudio/shared/workspaces';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useToast } from '@/components/ui/Toast';
import { updateAppSettings } from '@/features/settings/app/api';
import { markAppSettingsLocalWrite } from '@/features/settings/app/local-write-window';
import { appSettingsKeys, appSettingsQueryOptions } from '@/features/settings/app/queries';
import { useI18n } from '@/hooks/use-i18n';

export {
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PROMPT_SETTINGS,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
};

const SETTINGS_SAVE_DEBOUNCE_MS = 300;

function createCustomRule(): RuleFileSetting {
  return {
    id: `custom-${Date.now()}`,
    label: '',
    path: '',
    enabled: false,
    injectionRole: 'system',
    sendFrequency: 'first-turn',
  };
}

/**
 * App settings auto-save. Every setter writes the cache immediately and lets a
 * trailing debounce carry the whole object to the server, so a burst of edits
 * costs one PUT.
 *
 * The PUT replaces the full settings object, which makes concurrent edits from
 * two tabs last-writer-wins on the whole object rather than per field. That is
 * accepted for a local-first, single-user app; a realtime `app` invalidation
 * brings the loser back in sync as soon as its own write window closes.
 */
export function useGlobalSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useI18n();
  const pendingSaveRef = useRef<AppSettings | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * State to restore when a save fails, captured when an edit burst starts.
   * It cannot be read at mutate time: the setters write the cache immediately,
   * so by then the optimistic value is all that is left.
   */
  const rollbackRef = useRef<AppSettings | null>(null);
  /**
   * Monotonic submission counter. An edit made while a PUT is still open starts
   * a second one, and the two can settle out of order, so only the newest
   * submission is allowed to write the cache — an older response must never
   * reinstate a value the user has already moved past.
   */
  const saveSequenceRef = useRef(0);
  const { data, isLoading, error } = useQuery({
    ...appSettingsQueryOptions(),
    placeholderData: DEFAULT_APP_SETTINGS,
  });

  const mutation = useMutation({
    mutationKey: appSettingsKeys.save(),
    mutationFn: updateAppSettings,
    onMutate: () => {
      saveSequenceRef.current += 1;
      return { previousSettings: rollbackRef.current, sequence: saveSequenceRef.current };
    },
    onError: (_error, _nextSettings, context) => {
      // A silent rollback reads as a control that simply refused to move.
      toast(t.settings.autoSave.errorToast, 'error');
      // A superseded save must not roll back: a newer submission either already
      // persisted its value or will report its own failure against it.
      if (context?.sequence !== saveSequenceRef.current) return;
      if (!context.previousSettings) return;
      queryClient.setQueryData(appSettingsKeys.current(), context.previousSettings);
    },
    onSuccess: (savedSettings, _nextSettings, context) => {
      // Re-marked here so the echo window still covers the server's own event,
      // which cannot arrive before the write that triggered it has settled. Only
      // a successful write publishes one, so a failure leaves the window closed
      // and the next invalidation is free to repair the rolled-back cache.
      markAppSettingsLocalWrite();
      if (context.sequence !== saveSequenceRef.current) return;
      queryClient.setQueryData(appSettingsKeys.current(), normalizeAppSettings(savedSettings));
    },
    onSettled: () => {
      // A save queued mid-flight keeps the burst — and its rollback target — open.
      if (pendingSaveRef.current === null) rollbackRef.current = null;
    },
  });

  const settings = useMemo(() => normalizeAppSettings(data ?? DEFAULT_APP_SETTINGS), [data]);

  /**
   * `useMutation` returns a fresh object on every render, so the debounce must
   * key off `mutate` — which is stable for the observer's lifetime — and never
   * off the result object: the unmount-flush effect below re-runs its cleanup
   * whenever its dependency changes, so an unstable one would flush the pending
   * save on every re-render and the debounce would never coalesce anything.
   */
  const { mutate } = mutation;

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const pendingSettings = pendingSaveRef.current;
    if (!pendingSettings) return;

    pendingSaveRef.current = null;
    mutate(pendingSettings);
  }, [mutate]);

  useEffect(
    () => () => {
      flushPendingSave();
    },
    [flushPendingSave]
  );

  const saveSettings = useCallback(
    (updater: (current: AppSettings) => AppSettings) => {
      const currentSettings = normalizeAppSettings(
        queryClient.getQueryData<AppSettings>(appSettingsKeys.current()) ?? DEFAULT_APP_SETTINGS
      );

      rollbackRef.current ??= currentSettings;
      // Normalizing here is what keeps auto-save from ever sending an
      // out-of-range value: every clamp the schema declares is applied to the
      // local edit before it is queued.
      const nextSettings = normalizeAppSettings(updater(currentSettings));
      queryClient.setQueryData(appSettingsKeys.current(), nextSettings);
      pendingSaveRef.current = nextSettings;
      // Opens the echo window at the first keystroke, not at the PUT, so the
      // whole debounce is protected too.
      markAppSettingsLocalWrite();

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        flushPendingSave();
      }, SETTINGS_SAVE_DEBOUNCE_MS);
    },
    [flushPendingSave, queryClient]
  );

  const updatePromptSettings = useCallback(
    (updater: (current: AppSettings['promptSettings']) => AppSettings['promptSettings']) => {
      saveSettings((current) => ({
        ...current,
        promptSettings: updater(current.promptSettings),
      }));
    },
    [saveSettings]
  );

  const updateContextSettings = useCallback(
    (updates: Partial<ContextSettings>) => {
      saveSettings((current) => ({
        ...current,
        contextSettings: { ...current.contextSettings, ...updates },
      }));
    },
    [saveSettings]
  );

  const updateChatTitleSettings = useCallback(
    (updates: Partial<ChatTitleSettings>) => {
      saveSettings((current) => ({
        ...current,
        chatTitleSettings: normalizeChatTitleSettings({
          ...current.chatTitleSettings,
          ...updates,
        }),
      }));
    },
    [saveSettings]
  );

  const updateMultiAgentSettings = useCallback(
    (updates: Partial<MultiAgentSettings>) => {
      saveSettings((current) => ({
        ...current,
        multiAgentSettings: {
          ...current.multiAgentSettings,
          ...updates,
        },
      }));
    },
    [saveSettings]
  );

  const updateWorkspaceSettings = useCallback(
    (updater: (current: WorkspaceSettings) => WorkspaceSettings) => {
      saveSettings((current) => ({
        ...current,
        workspaceSettings: updater(current.workspaceSettings),
      }));
    },
    [saveSettings]
  );

  const updateWorkspacePanelSettings = useCallback(
    (updater: (current: WorkspacePanelSettings) => WorkspacePanelSettings) => {
      updateWorkspaceSettings((current) => ({
        ...current,
        sidePanel: updater(current.sidePanel),
      }));
    },
    [updateWorkspaceSettings]
  );

  const setWorkspacePanelVisible = useCallback(
    (panelId: WorkspacePanelId, visible: boolean) => {
      updateWorkspacePanelSettings((current) => {
        const visiblePanelIds = current.visiblePanelIds.filter((id) => id !== panelId);
        if (visible) visiblePanelIds.push(panelId);
        return { ...current, visiblePanelIds };
      });
    },
    [updateWorkspacePanelSettings]
  );

  const moveWorkspacePanel = useCallback(
    (panelId: WorkspacePanelId, direction: 'up' | 'down') => {
      updateWorkspacePanelSettings((current) => {
        const panelOrder = [...current.panelOrder];
        const currentIndex = panelOrder.indexOf(panelId);
        const nextIndex = currentIndex + (direction === 'up' ? -1 : 1);
        if (currentIndex === -1 || nextIndex < 0 || nextIndex >= panelOrder.length) return current;
        [panelOrder[currentIndex], panelOrder[nextIndex]] = [
          panelOrder[nextIndex],
          panelOrder[currentIndex],
        ];
        return { ...current, panelOrder };
      });
    },
    [updateWorkspacePanelSettings]
  );

  const updateChatDisplaySettings = useCallback(
    (updates: Partial<ChatDisplaySettings>) => {
      saveSettings((current) => ({
        ...current,
        chatDisplaySettings: { ...current.chatDisplaySettings, ...updates },
      }));
    },
    [saveSettings]
  );

  const updateGitSettings = useCallback(
    (updates: Partial<AppSettings['gitSettings']>) => {
      saveSettings((current) => ({
        ...current,
        gitSettings: { ...current.gitSettings, ...updates },
      }));
    },
    [saveSettings]
  );

  const updateExternalApiSettings = useCallback(
    (updates: Partial<AppSettings['externalApiSettings']>) => {
      saveSettings((current) => ({
        ...current,
        externalApiSettings: { ...current.externalApiSettings, ...updates },
      }));
    },
    [saveSettings]
  );

  const updateCommitMessageSettings = useCallback(
    (updates: Partial<AppSettings['gitSettings']['commitMessage']>) => {
      saveSettings((current) => ({
        ...current,
        gitSettings: {
          ...current.gitSettings,
          commitMessage: { ...current.gitSettings.commitMessage, ...updates },
        },
      }));
    },
    [saveSettings]
  );

  const setTextSystemPrompt = useCallback(
    (value: string) => {
      updatePromptSettings((current) => ({ ...current, textSystemPrompt: value }));
    },
    [updatePromptSettings]
  );

  const setImageSystemPrompt = useCallback(
    (value: string) => {
      updatePromptSettings((current) => ({ ...current, imageSystemPrompt: value }));
    },
    [updatePromptSettings]
  );

  const updateRuleFileSetting = useCallback(
    (id: string, updates: Partial<RuleFileSetting>) => {
      updatePromptSettings((current) => {
        if (id === 'agentsMd' || id === 'claudeMd') {
          return {
            ...current,
            [id]: { ...current[id], ...updates },
          };
        }

        return {
          ...current,
          customRules: current.customRules.map((rule) =>
            rule.id === id ? { ...rule, ...updates } : rule
          ),
        };
      });
    },
    [updatePromptSettings]
  );

  const addCustomRule = useCallback(() => {
    updatePromptSettings((current) => ({
      ...current,
      customRules: [...current.customRules, createCustomRule()],
    }));
  }, [updatePromptSettings]);

  const removeCustomRule = useCallback(
    (id: string) => {
      updatePromptSettings((current) => ({
        ...current,
        customRules: current.customRules.filter((rule) => rule.id !== id),
      }));
    },
    [updatePromptSettings]
  );

  const resetSettings = useCallback(() => {
    saveSettings(() => DEFAULT_APP_SETTINGS);
  }, [saveSettings]);

  const globalTextSystemPrompt = settings.promptSettings.textSystemPrompt;
  const globalImageSystemPrompt = settings.promptSettings.imageSystemPrompt;

  return {
    isLoading,
    error,
    globalTextSystemPrompt,
    setGlobalTextSystemPrompt: setTextSystemPrompt,
    globalImageSystemPrompt,
    setGlobalImageSystemPrompt: setImageSystemPrompt,
    promptSettings: settings.promptSettings,
    setTextSystemPrompt,
    setImageSystemPrompt,
    updateRuleFileSetting,
    addCustomRule,
    removeCustomRule,
    globalImageQuality: settings.globalImageQuality,
    setGlobalImageQuality: (value: string) => {
      saveSettings((current) => ({
        ...current,
        globalImageQuality: value as ImageQuality,
      }));
    },
    thinkingEnabled: settings.thinkingEnabled,
    setThinkingEnabled: (value: boolean) => {
      saveSettings((current) => ({ ...current, thinkingEnabled: value }));
    },
    reasoningEffort: settings.reasoningEffort,
    setReasoningEffort: (value: ReasoningEffort) => {
      saveSettings((current) => ({ ...current, reasoningEffort: value }));
    },
    maxToolIterations: settings.maxToolIterations,
    setMaxToolIterations: (value: number) => {
      saveSettings((current) => ({
        ...current,
        maxToolIterations: clampMaxToolIterations(value),
      }));
    },
    contextSettings: settings.contextSettings,
    multiAgentSettings: settings.multiAgentSettings,
    workspaceSettings: settings.workspaceSettings,
    gitSettings: settings.gitSettings,
    externalApiSettings: settings.externalApiSettings,
    chatTitleSettings: settings.chatTitleSettings,
    chatDisplaySettings: settings.chatDisplaySettings,
    setDiffPreviewsEnabled: (value: boolean) =>
      updateChatDisplaySettings({ diffPreviewsEnabled: value }),
    setDiffPreviewMode: (value: DiffPreviewMode) =>
      updateChatDisplaySettings({ diffPreviewMode: value }),
    setContextCompactionBehavior: (value: ContextCompactionBehavior) =>
      updateContextSettings({ compactionBehavior: value }),
    setContextWarningThreshold: (value: number) =>
      updateContextSettings({ warningThreshold: value }),
    setContextDangerThreshold: (value: number) => updateContextSettings({ dangerThreshold: value }),
    setContextHardStopThreshold: (value: number) =>
      updateContextSettings({ hardStopThreshold: value }),
    setPreferredSummaryModel: (value: string) =>
      updateContextSettings({ preferredSummaryModel: value }),
    setProviderCompactionEnabled: (value: boolean) =>
      updateContextSettings({ providerCompactionEnabled: value }),
    setMultiAgentEnabled: (value: boolean) => updateMultiAgentSettings({ enabled: value }),
    setChatDelegationEnabled: (value: boolean) =>
      updateMultiAgentSettings({ chatDelegationEnabled: value }),
    setTraceVisibility: (value: MultiAgentSettings['traceVisibility']) =>
      updateMultiAgentSettings({ traceVisibility: value }),
    setMaxDelegationDepth: (value: number) => updateMultiAgentSettings({ maxDepth: value }),
    setMaxSubagentCalls: (value: number) => updateMultiAgentSettings({ maxSubagentCalls: value }),
    setSubagentTimeoutMs: (value: number) => updateMultiAgentSettings({ timeoutMs: value }),
    setDefaultSubagentMaxTurns: (value: number) =>
      updateMultiAgentSettings({ defaultMaxTurns: value }),
    setDefaultWorkdir: (value: string) =>
      updateWorkspaceSettings((current) => ({ ...current, defaultWorkdir: value })),
    setRestrictToolsToWorkdir: (value: boolean) =>
      updateWorkspaceSettings((current) => ({ ...current, restrictToolsToWorkdir: value })),
    setWorkspacePanelVisible,
    moveWorkspacePanel,
    setWorkspacePanelWidth: (value: number) =>
      updateWorkspacePanelSettings((current) => ({ ...current, width: value })),
    setChatSidebarWidth: (value: number) =>
      updateWorkspaceSettings((current) => ({ ...current, chatSidebarWidth: value })),
    addRecentWorkdir: (value: string) =>
      updateWorkspaceSettings((current) => ({
        ...current,
        recentWorkdirs: [
          value,
          ...current.recentWorkdirs.filter((workdir) => workdir !== value),
        ].slice(0, RECENT_WORKDIRS_MAX),
      })),
    setChatAutoRenameEnabled: (value: boolean) =>
      updateChatTitleSettings({ autoRenameEnabled: value }),
    setChatTitleStrategy: (value: ChatTitleStrategy) =>
      updateChatTitleSettings({ strategy: value }),
    setChatTitlePromptPrefixLength: (value: number) =>
      updateChatTitleSettings({ promptPrefixLength: value }),
    setPreferredChatTitleModel: (value: string) =>
      updateChatTitleSettings({ preferredModel: value }),
    setSignCommits: (value: boolean) => updateGitSettings({ signCommits: value }),
    setSignOff: (value: boolean) => updateGitSettings({ signOff: value }),
    setPreferredCommitMessageModel: (value: string) =>
      updateCommitMessageSettings({ preferredModel: value }),
    setCommitMessageSystemPrompt: (value: string) =>
      updateCommitMessageSettings({ systemPrompt: value }),
    resetCommitMessageSystemPrompt: () =>
      updateCommitMessageSettings({ systemPrompt: DEFAULT_COMMIT_MESSAGE_PROMPT }),
    setCommitMessageMaxDiffKb: (value: number) => updateCommitMessageSettings({ maxDiffKb: value }),
    setExternalApiEnabled: (value: boolean) => updateExternalApiSettings({ enabled: value }),
    resetSettings,
  };
}
