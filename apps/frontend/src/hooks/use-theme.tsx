import { useState, useEffect, useCallback, createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'mango-studio-theme';

export interface ThemeConfig {
  /** Visual theme: dark, light, or follow OS preference. */
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

export type ResolvedTheme = 'dark' | 'light';

interface ThemeContextValue {
  config: ThemeConfig;
  /** The resolved visual theme (never 'system'). */
  resolvedTheme: ResolvedTheme;
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
  // Initialize synchronously from localStorage to avoid a flash on mount.
  const [config, setConfigState] = useState<ThemeConfig>(readStoredConfig);
  // Track OS preference separately so system theme reacts to OS changes.
  const [systemIsDark, setSystemIsDark] = useState<boolean>(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  // resolvedTheme is purely derived — never stored as independent state.
  const resolvedTheme = useMemo<ResolvedTheme>(
    () => (config.appTheme === 'system' ? (systemIsDark ? 'dark' : 'light') : config.appTheme),
    [config.appTheme, systemIsDark]
  );

  // Persist config & apply data attributes whenever config or resolved theme changes.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // ignore write failures (private browsing, quota exceeded, etc.)
    }
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.fontSize = config.fontSize;
    document.documentElement.dataset.chatDensity = config.chatDensity;
  }, [config, resolvedTheme]);

  // Listen for OS preference changes when using 'system' theme.
  useEffect(() => {
    if (config.appTheme !== 'system') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystemIsDark(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [config.appTheme]);

  const setConfig = useCallback((patch: Partial<ThemeConfig>) => {
    setConfigState((prev) => ({ ...prev, ...patch }));
  }, []);

  const value = useMemo(
    () => ({ config, resolvedTheme, setConfig }),
    [config, resolvedTheme, setConfig]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
