import { useState, useCallback, useEffect } from 'react';
import type { ReasoningEffort } from '@mangostudio/shared';
import type { ContextCompactionBehavior, ContextSettings } from '@mangostudio/shared/chat';
import type {
  PromptInjectionRole,
  PromptSendFrequency,
  RuleFileSetting,
  PromptSettings,
} from '@mangostudio/shared/prompt-rules';
import { readStorage, writeStorage } from '@/lib/storage';

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  textSystemPrompt: '',
  imageSystemPrompt: '',
  agentsMd: {
    id: 'agentsMd',
    label: 'AGENTS.md',
    path: '~/.mango/AGENTS.md',
    enabled: false,
    injectionRole: 'system',
    sendFrequency: 'first-turn',
  },
  claudeMd: {
    id: 'claudeMd',
    label: 'CLAUDE.md',
    path: '~/.claude/CLAUDE.md',
    enabled: false,
    injectionRole: 'system',
    sendFrequency: 'first-turn',
  },
  customRules: [],
};

const PROMPT_SETTINGS_STORAGE_KEY = 'mangostudio:promptSettings';

export const MAX_TOOL_ITERATIONS_MIN = 1;
export const MAX_TOOL_ITERATIONS_MAX = 25;
export const MAX_TOOL_ITERATIONS_DEFAULT = 10;
export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  compactionBehavior: 'ask',
  warningThreshold: 0.85,
  dangerThreshold: 0.92,
  hardStopThreshold: 0.97,
  preferredSummaryModel: 'current_model',
  providerCompactionEnabled: true,
};

const CONTEXT_SETTINGS_STORAGE_KEY = 'mangostudio:contextSettings';

function clampThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0.99, Math.max(0.5, Math.round(value * 100) / 100));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPromptInjectionRole(value: unknown): value is PromptInjectionRole {
  return value === 'system' || value === 'user';
}

function isPromptSendFrequency(value: unknown): value is PromptSendFrequency {
  return value === 'first-turn' || value === 'every-turn';
}

function normalizeRuleFileSetting(value: unknown, fallback: RuleFileSetting): RuleFileSetting {
  if (!isRecord(value)) return fallback;
  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : fallback.id,
    label: typeof value.label === 'string' ? value.label : fallback.label,
    path: typeof value.path === 'string' ? value.path : fallback.path,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    injectionRole: isPromptInjectionRole(value.injectionRole)
      ? value.injectionRole
      : fallback.injectionRole,
    sendFrequency: isPromptSendFrequency(value.sendFrequency)
      ? value.sendFrequency
      : fallback.sendFrequency,
  };
}

function normalizePromptSettings(value: unknown): PromptSettings {
  if (!isRecord(value)) return DEFAULT_PROMPT_SETTINGS;
  return {
    textSystemPrompt: typeof value.textSystemPrompt === 'string' ? value.textSystemPrompt : '',
    imageSystemPrompt: typeof value.imageSystemPrompt === 'string' ? value.imageSystemPrompt : '',
    agentsMd: normalizeRuleFileSetting(value.agentsMd, DEFAULT_PROMPT_SETTINGS.agentsMd),
    claudeMd: normalizeRuleFileSetting(value.claudeMd, DEFAULT_PROMPT_SETTINGS.claudeMd),
    customRules: Array.isArray(value.customRules)
      ? value.customRules.map((r: unknown) =>
          normalizeRuleFileSetting(r, {
            id: `custom-${Date.now()}`,
            label: '',
            path: '',
            enabled: false,
            injectionRole: 'system',
            sendFrequency: 'first-turn',
          })
        )
      : [],
  };
}

function readPromptSettings(): PromptSettings {
  try {
    const raw = localStorage.getItem(PROMPT_SETTINGS_STORAGE_KEY);
    if (raw) return normalizePromptSettings(JSON.parse(raw));

    const oldText = readStorage('globalTextSystemPrompt', '');
    const oldImage = readStorage('globalImageSystemPrompt', '');
    if (oldText || oldImage) {
      const migrated: PromptSettings = {
        ...DEFAULT_PROMPT_SETTINGS,
        textSystemPrompt: oldText,
        imageSystemPrompt: oldImage,
      };
      localStorage.setItem(PROMPT_SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }

    return DEFAULT_PROMPT_SETTINGS;
  } catch {
    return DEFAULT_PROMPT_SETTINGS;
  }
}

function isCompactionBehavior(value: unknown): value is ContextCompactionBehavior {
  return (
    value === 'ask' ||
    value === 'auto_compact_current_chat' ||
    value === 'continue_with_summary_new_chat' ||
    value === 'off'
  );
}

function normalizeContextSettings(value: unknown): ContextSettings {
  if (!isRecord(value)) return DEFAULT_CONTEXT_SETTINGS;

  const warningThreshold = clampThreshold(
    typeof value.warningThreshold === 'number'
      ? value.warningThreshold
      : DEFAULT_CONTEXT_SETTINGS.warningThreshold,
    DEFAULT_CONTEXT_SETTINGS.warningThreshold
  );
  const dangerThreshold = clampThreshold(
    typeof value.dangerThreshold === 'number'
      ? value.dangerThreshold
      : DEFAULT_CONTEXT_SETTINGS.dangerThreshold,
    DEFAULT_CONTEXT_SETTINGS.dangerThreshold
  );
  const hardStopThreshold = clampThreshold(
    typeof value.hardStopThreshold === 'number'
      ? value.hardStopThreshold
      : DEFAULT_CONTEXT_SETTINGS.hardStopThreshold,
    DEFAULT_CONTEXT_SETTINGS.hardStopThreshold
  );
  const [normalizedWarning, normalizedDanger, normalizedHardStop] = [
    warningThreshold,
    dangerThreshold,
    hardStopThreshold,
  ].sort((left, right) => left - right);

  return {
    compactionBehavior: isCompactionBehavior(value.compactionBehavior)
      ? value.compactionBehavior
      : DEFAULT_CONTEXT_SETTINGS.compactionBehavior,
    warningThreshold: normalizedWarning,
    dangerThreshold: normalizedDanger,
    hardStopThreshold: normalizedHardStop,
    preferredSummaryModel:
      typeof value.preferredSummaryModel === 'string' && value.preferredSummaryModel.length > 0
        ? value.preferredSummaryModel
        : DEFAULT_CONTEXT_SETTINGS.preferredSummaryModel,
    providerCompactionEnabled:
      typeof value.providerCompactionEnabled === 'boolean'
        ? value.providerCompactionEnabled
        : DEFAULT_CONTEXT_SETTINGS.providerCompactionEnabled,
  };
}

function readContextSettings(): ContextSettings {
  try {
    const raw = localStorage.getItem(CONTEXT_SETTINGS_STORAGE_KEY);
    return raw ? normalizeContextSettings(JSON.parse(raw)) : DEFAULT_CONTEXT_SETTINGS;
  } catch {
    return DEFAULT_CONTEXT_SETTINGS;
  }
}

function clampMaxToolIterations(value: number): number {
  if (!Number.isFinite(value)) return MAX_TOOL_ITERATIONS_DEFAULT;
  const rounded = Math.round(value);
  if (rounded < MAX_TOOL_ITERATIONS_MIN) return MAX_TOOL_ITERATIONS_MIN;
  if (rounded > MAX_TOOL_ITERATIONS_MAX) return MAX_TOOL_ITERATIONS_MAX;
  return rounded;
}

export function useGlobalSettings() {
  const [promptSettings, setPromptSettings] = useState<PromptSettings>(readPromptSettings);
  const [globalImageQuality, setGlobalImageQuality] = useState(() =>
    readStorage('globalImageQuality', '1K')
  );
  const [thinkingEnabled, setThinkingEnabled] = useState(() =>
    readStorage('thinkingEnabled', false)
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    () => readStorage('reasoningEffort', 'medium') as ReasoningEffort
  );
  const [maxToolIterations, setMaxToolIterations] = useState<number>(() =>
    clampMaxToolIterations(readStorage('maxToolIterations', MAX_TOOL_ITERATIONS_DEFAULT))
  );
  const [contextSettings, setContextSettings] = useState<ContextSettings>(readContextSettings);

  const updateMaxToolIterations = useCallback((value: number) => {
    setMaxToolIterations(clampMaxToolIterations(value));
  }, []);

  const updateContextSettings = useCallback((updates: Partial<ContextSettings>) => {
    setContextSettings((current) => normalizeContextSettings({ ...current, ...updates }));
  }, []);

  useEffect(() => {
    localStorage.setItem(PROMPT_SETTINGS_STORAGE_KEY, JSON.stringify(promptSettings));
  }, [promptSettings]);

  useEffect(() => {
    writeStorage('globalImageQuality', globalImageQuality);
  }, [globalImageQuality]);

  useEffect(() => {
    writeStorage('thinkingEnabled', thinkingEnabled);
  }, [thinkingEnabled]);

  useEffect(() => {
    writeStorage('reasoningEffort', reasoningEffort);
  }, [reasoningEffort]);

  useEffect(() => {
    writeStorage('maxToolIterations', maxToolIterations);
  }, [maxToolIterations]);

  useEffect(() => {
    writeStorage('contextSettings', contextSettings);
  }, [contextSettings]);

  const setTextSystemPrompt = useCallback((value: string) => {
    setPromptSettings((prev) => normalizePromptSettings({ ...prev, textSystemPrompt: value }));
  }, []);

  const setImageSystemPrompt = useCallback((value: string) => {
    setPromptSettings((prev) => normalizePromptSettings({ ...prev, imageSystemPrompt: value }));
  }, []);

  const updateRuleFileSetting = useCallback((id: string, updates: Partial<RuleFileSetting>) => {
    setPromptSettings((prev) => {
      if (id === 'agentsMd' || id === 'claudeMd') {
        return normalizePromptSettings({
          ...prev,
          [id]: { ...prev[id], ...updates },
        });
      }
      return normalizePromptSettings({
        ...prev,
        customRules: prev.customRules.map((r) => (r.id === id ? { ...r, ...updates } : r)),
      });
    });
  }, []);

  const addCustomRule = useCallback(() => {
    setPromptSettings((prev) =>
      normalizePromptSettings({
        ...prev,
        customRules: [
          ...prev.customRules,
          {
            id: `custom-${Date.now()}`,
            label: '',
            path: '',
            enabled: false,
            injectionRole: 'system',
            sendFrequency: 'first-turn',
          },
        ],
      })
    );
  }, []);

  const removeCustomRule = useCallback((id: string) => {
    setPromptSettings((prev) =>
      normalizePromptSettings({
        ...prev,
        customRules: prev.customRules.filter((r) => r.id !== id),
      })
    );
  }, []);

  const resetSettings = useCallback(() => {
    setPromptSettings(DEFAULT_PROMPT_SETTINGS);
    setGlobalImageQuality('1K');
    setThinkingEnabled(false);
    setReasoningEffort('medium');
    setMaxToolIterations(MAX_TOOL_ITERATIONS_DEFAULT);
    setContextSettings(DEFAULT_CONTEXT_SETTINGS);
  }, []);

  const globalTextSystemPrompt = promptSettings.textSystemPrompt;
  const globalImageSystemPrompt = promptSettings.imageSystemPrompt;

  return {
    globalTextSystemPrompt,
    setGlobalTextSystemPrompt: setTextSystemPrompt,
    globalImageSystemPrompt,
    setGlobalImageSystemPrompt: setImageSystemPrompt,
    promptSettings,
    setTextSystemPrompt,
    setImageSystemPrompt,
    updateRuleFileSetting,
    addCustomRule,
    removeCustomRule,
    globalImageQuality,
    setGlobalImageQuality,
    thinkingEnabled,
    setThinkingEnabled,
    reasoningEffort,
    setReasoningEffort,
    maxToolIterations,
    setMaxToolIterations: updateMaxToolIterations,
    contextSettings,
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
    resetSettings,
  };
}
