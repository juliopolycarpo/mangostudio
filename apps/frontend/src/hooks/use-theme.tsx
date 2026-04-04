import { useState, useEffect, useCallback, createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'mango-studio-theme';

export interface ThemeConfig {
  /** Visual theme. 'light' and 'system' added in a future PR. */
  appTheme: 'dark' | 'light' | 'system';
  /** Code highlighting theme. More options added in a future PR. */
  codeTheme: string;
  /** Chat message font size. */
  fontSize: 'small' | 'default' | 'large';
  /** Spacing between chat messages. */
  chatDensity: 'compact' | 'default' | 'comfortable';
}

const DEFAULT_CONFIG: ThemeConfig = {
  appTheme: 'dark',
  codeTheme: 'one-dark-pro',
  fontSize: 'default',
  chatDensity: 'default',
};

interface ThemeContextValue {
  config: ThemeConfig;
  setConfig: (patch: Partial<ThemeConfig>) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredConfig(): ThemeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<ThemeConfig>) };
    }
  } catch {
    // localStorage unavailable or corrupted — use defaults
  }
  return DEFAULT_CONFIG;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<ThemeConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    setConfigState(readStoredConfig());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // ignore write failures (private browsing, quota exceeded, etc.)
    }
    document.documentElement.dataset.theme = config.appTheme;
    document.documentElement.dataset.fontSize = config.fontSize;
    document.documentElement.dataset.chatDensity = config.chatDensity;
  }, [config]);

  const setConfig = useCallback((patch: Partial<ThemeConfig>) => {
    setConfigState((prev) => ({ ...prev, ...patch }));
  }, []);

  const value = useMemo(() => ({ config, setConfig }), [config, setConfig]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
