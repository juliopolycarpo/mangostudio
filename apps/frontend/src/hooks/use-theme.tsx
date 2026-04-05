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

type ResolvedTheme = 'dark' | 'light';

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

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(appTheme: ThemeConfig['appTheme']): ResolvedTheme {
  return appTheme === 'system' ? getSystemTheme() : appTheme;
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<ThemeConfig>(DEFAULT_CONFIG);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(DEFAULT_CONFIG.appTheme)
  );

  useEffect(() => {
    const stored = readStoredConfig();
    setConfigState(stored);
    const resolved = resolveTheme(stored.appTheme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
  }, []);

  // Persist config & apply data attributes when config changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // ignore write failures (private browsing, quota exceeded, etc.)
    }
    const resolved = resolveTheme(config.appTheme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    document.documentElement.dataset.fontSize = config.fontSize;
    document.documentElement.dataset.chatDensity = config.chatDensity;
  }, [config]);

  // Listen for OS preference changes when using 'system' theme
  useEffect(() => {
    if (config.appTheme !== 'system') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const resolved = getSystemTheme();
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
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
