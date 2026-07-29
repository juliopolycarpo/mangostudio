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
import { updateAppSettings } from '@/features/settings/app/api';
import { appSettingsKeys, appSettingsQueryOptions } from '@/features/settings/app/queries';

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

export function useGlobalSettings() {
  const queryClient = useQueryClient();
  const pendingSaveRef = useRef<AppSettings | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data, isLoading, error } = useQuery({
    ...appSettingsQueryOptions(),
    placeholderData: DEFAULT_APP_SETTINGS,
  });

  const mutation = useMutation({
    mutationFn: updateAppSettings,
    onMutate: (nextSettings: AppSettings) => {
      const previousSettings =
        queryClient.getQueryData<AppSettings>(appSettingsKeys.current()) ?? DEFAULT_APP_SETTINGS;
      queryClient.setQueryData(appSettingsKeys.current(), nextSettings);
      return { previousSettings };
    },
    onError: (_error, _nextSettings, context) => {
      if (!context?.previousSettings) return;
      queryClient.setQueryData(appSettingsKeys.current(), context.previousSettings);
    },
    onSuccess: (savedSettings) => {
      queryClient.setQueryData(appSettingsKeys.current(), normalizeAppSettings(savedSettings));
    },
  });

  const settings = useMemo(() => normalizeAppSettings(data ?? DEFAULT_APP_SETTINGS), [data]);

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const pendingSettings = pendingSaveRef.current;
    if (!pendingSettings) return;

    pendingSaveRef.current = null;
    mutation.mutate(pendingSettings);
  }, [mutation]);

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

      const nextSettings = normalizeAppSettings(updater(currentSettings));
      queryClient.setQueryData(appSettingsKeys.current(), nextSettings);
      pendingSaveRef.current = nextSettings;

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
