import { useState, useCallback, useEffect } from 'react';
import type { ReasoningEffort } from '@mangostudio/shared';
import { readStorage, writeStorage } from '@/lib/storage';

export const MAX_TOOL_ITERATIONS_MIN = 1;
export const MAX_TOOL_ITERATIONS_MAX = 25;
export const MAX_TOOL_ITERATIONS_DEFAULT = 10;

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

  const updateMaxToolIterations = useCallback((value: number) => {
    setMaxToolIterations(clampMaxToolIterations(value));
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

  const resetSettings = useCallback(() => {
    setGlobalTextSystemPrompt('');
    setGlobalImageSystemPrompt('');
    setGlobalImageQuality('1K');
    setThinkingEnabled(false);
    setReasoningEffort('medium');
    setMaxToolIterations(MAX_TOOL_ITERATIONS_DEFAULT);
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
    resetSettings,
  };
}
