import { useState, useCallback, useEffect } from 'react';
import type { ReasoningEffort } from '@mangostudio/shared';
import type { ContextCompactionBehavior, ContextSettings } from '@mangostudio/shared/chat';
import { readStorage, writeStorage } from '@/lib/storage';

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
  const [globalTextSystemPrompt, setGlobalTextSystemPrompt] = useState(() =>
    readStorage('globalTextSystemPrompt', '')
  );
  const [globalImageSystemPrompt, setGlobalImageSystemPrompt] = useState(() =>
    readStorage('globalImageSystemPrompt', '')
  );
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
    writeStorage('globalTextSystemPrompt', globalTextSystemPrompt);
  }, [globalTextSystemPrompt]);

  useEffect(() => {
    writeStorage('globalImageSystemPrompt', globalImageSystemPrompt);
  }, [globalImageSystemPrompt]);

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

  const resetSettings = useCallback(() => {
    setGlobalTextSystemPrompt('');
    setGlobalImageSystemPrompt('');
    setGlobalImageQuality('1K');
    setThinkingEnabled(false);
    setReasoningEffort('medium');
    setMaxToolIterations(MAX_TOOL_ITERATIONS_DEFAULT);
    setContextSettings(DEFAULT_CONTEXT_SETTINGS);
  }, []);

  return {
    globalTextSystemPrompt,
    setGlobalTextSystemPrompt,
    globalImageSystemPrompt,
    setGlobalImageSystemPrompt,
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
