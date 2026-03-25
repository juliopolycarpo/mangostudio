/* global localStorage, console */
import { useState, useCallback, useEffect } from 'react';

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

  const resetSettings = useCallback(() => {
    setGlobalTextSystemPrompt('');
    setGlobalImageSystemPrompt('');
    setGlobalImageQuality('1K');
  }, []);

  return {
    globalTextSystemPrompt,
    setGlobalTextSystemPrompt,
    globalImageSystemPrompt,
    setGlobalImageSystemPrompt,
    globalImageQuality,
    setGlobalImageQuality,
    resetSettings,
  };
}
