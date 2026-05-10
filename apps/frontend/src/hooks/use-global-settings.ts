import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PROMPT_SETTINGS,
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  clampMaxToolIterations,
  normalizeAppSettings,
  normalizeChatTitleSettings,
  type AppSettings,
  type ChatTitleSettings,
  type ChatTitleStrategy,
  type ImageQuality,
} from '@mangostudio/shared/app-settings';
import type { ReasoningEffort } from '@mangostudio/shared';
import type { ContextCompactionBehavior, ContextSettings } from '@mangostudio/shared/chat';
import type { RuleFileSetting } from '@mangostudio/shared/prompt-rules';
import { updateAppSettings } from '@/features/settings/app/api';
import { appSettingsKeys, appSettingsQueryOptions } from '@/features/settings/app/queries';

export {
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PROMPT_SETTINGS,
  MAX_TOOL_ITERATIONS_DEFAULT,
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
    chatTitleSettings: settings.chatTitleSettings,
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
    setChatAutoRenameEnabled: (value: boolean) =>
      updateChatTitleSettings({ autoRenameEnabled: value }),
    setChatTitleStrategy: (value: ChatTitleStrategy) =>
      updateChatTitleSettings({ strategy: value }),
    setChatTitlePromptPrefixLength: (value: number) =>
      updateChatTitleSettings({ promptPrefixLength: value }),
    setPreferredChatTitleModel: (value: string) =>
      updateChatTitleSettings({ preferredModel: value }),
    resetSettings,
  };
}
