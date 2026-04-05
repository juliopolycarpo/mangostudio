import { useState, useEffect, useCallback, createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { CodeThemeId } from '@/lib/shiki';

const STORAGE_KEY = 'mango-studio-theme';

export interface CodeThemeConfig {
  mode: 'manual' | 'auto';
  /** Theme used in manual mode, or dark preference in auto mode. */
  darkTheme: CodeThemeId;
  /** Light preference in auto mode. */
  lightTheme: CodeThemeId;
}

export interface ThemeConfig {
  /** Visual theme: dark, light, or follow OS preference. */
  appTheme: 'dark' | 'light' | 'system';
  /** Code highlighting theme config. */
  codeTheme: CodeThemeConfig;
  /** Chat message font size. */
  fontSize: 'small' | 'default' | 'large';
  /** Spacing between chat messages. */
  chatDensity: 'compact' | 'default' | 'comfortable';
}

const DEFAULT_CODE_THEME: CodeThemeConfig = {
  mode: 'auto',
  darkTheme: 'one-dark-pro',
  lightTheme: 'github-light',
};

const DEFAULT_CONFIG: ThemeConfig = {
  appTheme: 'dark',
  codeTheme: DEFAULT_CODE_THEME,
  fontSize: 'default',
  chatDensity: 'default',
};

export type ResolvedTheme = 'dark' | 'light';

interface ThemeContextValue {
  config: ThemeConfig;
  /** The resolved visual theme (never 'system'). */
  resolvedTheme: ResolvedTheme;
  /** The resolved code theme based on config mode and current app theme. */
  resolvedCodeTheme: CodeThemeId;
  setConfig: (patch: Partial<ThemeConfig>) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredConfig(): ThemeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Migrate legacy string codeTheme to CodeThemeConfig
      if (typeof parsed.codeTheme === 'string') {
        parsed.codeTheme = { ...DEFAULT_CODE_THEME, darkTheme: parsed.codeTheme };
      }
      return { ...DEFAULT_CONFIG, ...(parsed as Partial<ThemeConfig>) };
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

  const resolvedCodeTheme = useMemo<CodeThemeId>(() => {
    if (config.codeTheme.mode === 'manual') return config.codeTheme.darkTheme;
    return resolvedTheme === 'dark' ? config.codeTheme.darkTheme : config.codeTheme.lightTheme;
  }, [config.codeTheme, resolvedTheme]);

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
    () => ({ config, resolvedTheme, resolvedCodeTheme, setConfig }),
    [config, resolvedTheme, resolvedCodeTheme, setConfig]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
