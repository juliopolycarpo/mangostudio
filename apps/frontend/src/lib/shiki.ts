import { createHighlighter, type Highlighter, bundledThemes } from 'shiki';

const PRELOADED_LANGS = [
  'typescript',
  'javascript',
  'python',
  'json',
  'xml',
  'css',
  'html',
  'sql',
  'bash',
  'yaml',
  'markdown',
  'tsx',
  'jsx',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'swift',
  'powershell',
] as const;

/** Themes shipped in the initial bundle — always available, not uninstallable. */
export const BUILTIN_THEMES = ['one-dark-pro', 'one-light'] as const;

/** Themes shown in Settings as recommended for quick install. */
export const SUGGESTED_THEMES = ['github-dark-dimmed', 'github-light'] as const;

/** Full Shiki catalog for the marketplace. */
export type ShikiBundledTheme = keyof typeof bundledThemes;
export const SHIKI_THEME_CATALOG = Object.keys(bundledThemes) as ShikiBundledTheme[];

export type CodeThemeId = ShikiBundledTheme;

const INSTALLED_THEMES_KEY = 'mango-studio-installed-themes';

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;

export function getInstalledThemeIds(): CodeThemeId[] {
  try {
    const raw = localStorage.getItem(INSTALLED_THEMES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistInstalledThemeIds(ids: CodeThemeId[]) {
  localStorage.setItem(INSTALLED_THEMES_KEY, JSON.stringify(ids));
}

export function isThemeBuiltIn(id: string): boolean {
  return (BUILTIN_THEMES as readonly string[]).includes(id);
}

export function isThemeAvailable(id: CodeThemeId): boolean {
  return isThemeBuiltIn(id) || getInstalledThemeIds().includes(id);
}

/**
 * Load a theme on demand. Returns true if loaded successfully.
 * Pass `{ persist: false }` when loading only to generate a preview —
 * this avoids writing the theme to the installed list in localStorage.
 */
export async function loadThemeOnDemand(
  id: CodeThemeId,
  { persist = true }: { persist?: boolean } = {}
): Promise<boolean> {
  // Always await init so this works even if called before the highlighter is ready.
  const h = await initHighlighter();
  if (h.getLoadedThemes().includes(id)) return true;
  if (isThemeBuiltIn(id)) return true;
  try {
    await h.loadTheme(id);
    if (persist) {
      const installed = getInstalledThemeIds();
      if (!installed.includes(id)) {
        persistInstalledThemeIds([...installed, id]);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove a theme from installed list (uninstall). Built-in themes cannot be removed. */
export function uninstallTheme(id: CodeThemeId): boolean {
  if (isThemeBuiltIn(id)) return false;
  const installed = getInstalledThemeIds().filter((t) => t !== id);
  persistInstalledThemeIds(installed);
  return true;
}

export function initHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...BUILTIN_THEMES],
      langs: [...PRELOADED_LANGS],
    }).then(async (h) => {
      highlighterInstance = h;
      // Restore previously installed themes
      const installed = getInstalledThemeIds();
      await Promise.allSettled(installed.map((id) => h.loadTheme(id)));
      return h;
    });
  }
  return highlighterPromise;
}

export function highlightCode(code: string, lang: string, theme: CodeThemeId): string | null {
  if (!highlighterInstance) return null;
  try {
    return highlighterInstance.codeToHtml(code, { lang, theme });
  } catch {
    // Unknown language — return null to fall back to plain rendering
    return null;
  }
}

/** Get the highlighter instance (if already initialized). */
export function getHighlighterInstance(): Highlighter | null {
  return highlighterInstance;
}

// Start loading immediately on module import
void initHighlighter();
