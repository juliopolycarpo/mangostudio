import { useState, useCallback, useEffect } from 'react';
import type { ReasoningEffort } from '@mangostudio/shared';
import { readStorage, writeStorage } from '@/lib/storage';

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

  // Persist changes to localStorage
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

  const resetSettings = useCallback(() => {
    setGlobalTextSystemPrompt('');
    setGlobalImageSystemPrompt('');
    setGlobalImageQuality('1K');
    setThinkingEnabled(false);
    setReasoningEffort('medium');
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
    resetSettings,
  };
}
