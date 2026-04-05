/* global localStorage, console */
import { useState, useCallback, useEffect, useRef } from 'react';
import type { ReasoningEffort } from '@mangostudio/shared';
import { client } from '@/lib/api-client';

export function useGlobalSettings() {
  // Load from localStorage on init
  const loadFromStorage = <T>(key: string, defaultValue: T): T => {
    try {
      const item = localStorage.getItem(`mangostudio:${key}`);
      return item ? JSON.parse(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  };

  const saveToStorage = (key: string, value: unknown) => {
    try {
      localStorage.setItem(`mangostudio:${key}`, JSON.stringify(value));
    } catch (error) {
      console.error(`Failed to save ${key} to localStorage`, error);
    }
  };

  const [globalTextSystemPrompt, setGlobalTextSystemPrompt] = useState(() =>
    loadFromStorage('globalTextSystemPrompt', '')
  );
  const [globalImageSystemPrompt, setGlobalImageSystemPrompt] = useState(() =>
    loadFromStorage('globalImageSystemPrompt', '')
  );
  const [globalImageQuality, setGlobalImageQuality] = useState(() =>
    loadFromStorage('globalImageQuality', '1K')
  );
  const [thinkingEnabled, setThinkingEnabled] = useState(() =>
    loadFromStorage('thinkingEnabled', false)
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() =>
    loadFromStorage<ReasoningEffort>('reasoningEffort', 'medium')
  );

  // Persist changes to localStorage
  useEffect(() => {
    saveToStorage('globalTextSystemPrompt', globalTextSystemPrompt);
  }, [globalTextSystemPrompt]);

  useEffect(() => {
    saveToStorage('globalImageSystemPrompt', globalImageSystemPrompt);
  }, [globalImageSystemPrompt]);

  useEffect(() => {
    saveToStorage('globalImageQuality', globalImageQuality);
  }, [globalImageQuality]);

  useEffect(() => {
    saveToStorage('thinkingEnabled', thinkingEnabled);
  }, [thinkingEnabled]);

  useEffect(() => {
    saveToStorage('reasoningEffort', reasoningEffort);
  }, [reasoningEffort]);

  const resetSettings = useCallback(() => {
    setGlobalTextSystemPrompt('');
    setGlobalImageSystemPrompt('');
    setGlobalImageQuality('1K');
    setThinkingEnabled(false);
    setReasoningEffort('medium');
  }, []);

  // Background-sync all settings to server (debounced).
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      const value = {
        globalTextSystemPrompt,
        globalImageSystemPrompt,
        globalImageQuality,
        thinkingEnabled,
        reasoningEffort,
      };
      void (client as any).api.settings.preferences
        .put({ key: 'globalSettings', value })
        .catch(() => {});
    }, 1500);
  }, [
    globalTextSystemPrompt,
    globalImageSystemPrompt,
    globalImageQuality,
    thinkingEnabled,
    reasoningEffort,
  ]);

  // Fetch from server if no localStorage data exists.
  useEffect(() => {
    const hasLocal = localStorage.getItem('mangostudio:globalTextSystemPrompt') !== null;
    if (hasLocal) return;

    void (async () => {
      try {
        const { data } = await (client as any).api.settings.preferences.get();
        if (!Array.isArray(data)) return;
        const pref = data.find((p: { key: string }) => p.key === 'globalSettings');
        if (pref?.value && typeof pref.value === 'object') {
          const v = pref.value as Record<string, unknown>;
          if (typeof v.globalTextSystemPrompt === 'string')
            setGlobalTextSystemPrompt(v.globalTextSystemPrompt);
          if (typeof v.globalImageSystemPrompt === 'string')
            setGlobalImageSystemPrompt(v.globalImageSystemPrompt);
          if (typeof v.globalImageQuality === 'string') setGlobalImageQuality(v.globalImageQuality);
          if (typeof v.thinkingEnabled === 'boolean') setThinkingEnabled(v.thinkingEnabled);
          if (typeof v.reasoningEffort === 'string')
            setReasoningEffort(v.reasoningEffort as ReasoningEffort);
        }
      } catch {
        // Server unavailable
      }
    })();
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
