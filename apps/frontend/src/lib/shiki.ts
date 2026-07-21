import { createBundledHighlighter, type HighlighterGeneric } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import { CODE_THEMES, type CodeThemeId } from '@/lib/code-themes';

export { CODE_THEMES, type CodeThemeId } from '@/lib/code-themes';

const SHIKI_LANGUAGES = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsx: () => import('@shikijs/langs/jsx'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} as const;

const SHIKI_THEMES = {
  'github-dark-dimmed': () => import('@shikijs/themes/github-dark-dimmed'),
  'github-light': () => import('@shikijs/themes/github-light'),
  'one-dark-pro': () => import('@shikijs/themes/one-dark-pro'),
  'one-light': () => import('@shikijs/themes/one-light'),
} as const;

const COMMON_LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'bash',
  'python',
  'markdown',
] as const;

const LANGUAGE_ALIASES: Record<string, ShikiLanguageId> = {
  'c++': 'cpp',
  cs: 'csharp',
  csh: 'csharp',
  htm: 'html',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

type ShikiLanguageId = keyof typeof SHIKI_LANGUAGES;
type MangoHighlighter = HighlighterGeneric<ShikiLanguageId, CodeThemeId>;

const createMangoHighlighter = createBundledHighlighter({
  langs: SHIKI_LANGUAGES,
  themes: SHIKI_THEMES,
  engine: () => createJavaScriptRegexEngine(),
});

let highlighterPromise: Promise<MangoHighlighter> | null = null;
let highlighterInstance: MangoHighlighter | null = null;
const languageLoadPromises = new Map<ShikiLanguageId, Promise<void>>();

/** Initializes the shared Shiki highlighter with the common chat languages. */
// Usage: await initHighlighter();
export function initHighlighter(): Promise<MangoHighlighter> {
  highlighterPromise ??= createMangoHighlighter({
    themes: [...CODE_THEMES],
    langs: [...COMMON_LANGUAGES],
  }).then((highlighter) => {
    highlighterInstance = highlighter;
    return highlighter;
  });

  return highlighterPromise;
}

/** Loads fenced-code languages before markdown is parsed for highlighting. */
// Usage: await preloadCodeLanguages(['typescript', 'rust']);
export async function preloadCodeLanguages(languages: readonly string[]): Promise<boolean> {
  const languageIds = resolveUniqueLanguageIds(languages);
  if (languageIds.length === 0) return false;

  const highlighter = await initHighlighter();
  await Promise.all(languageIds.map((language) => loadLanguageOnce(highlighter, language)));
  return true;
}

/** Returns highlighted HTML when the highlighter and language are ready. */
// Usage: const html = highlightCode('const x = 1;', 'ts', 'one-dark-pro');
export function highlightCode(code: string, lang: string, theme: CodeThemeId): string | null {
  const language = resolveLanguageId(lang);
  if (!highlighterInstance || !language) return null;
  if (!isLanguageLoaded(highlighterInstance, language)) return null;

  try {
    return highlighterInstance.codeToHtml(code, { lang: language, theme });
  } catch {
    return null;
  }
}

export interface HighlightToken {
  readonly content: string;
  readonly color?: string;
  readonly offset: number;
}

/**
 * Returns safe token data for a SINGLE line, for code surfaces that render
 * their own line chrome. Only the first line of `line` is tokenized, so callers
 * must split multi-line input themselves.
 */
export function highlightLineTokens(
  line: string,
  lang: string,
  theme: CodeThemeId
): readonly HighlightToken[] | null {
  const language = resolveLanguageId(lang);
  if (!highlighterInstance || !language) return null;
  if (!isLanguageLoaded(highlighterInstance, language)) return null;

  try {
    return highlighterInstance.codeToTokensBase(line, { lang: language, theme })[0] ?? [];
  } catch {
    return null;
  }
}

function resolveUniqueLanguageIds(languages: readonly string[]): ShikiLanguageId[] {
  return [...new Set(languages.map(resolveLanguageId).filter(isLanguageId))];
}

function resolveLanguageId(lang: string): ShikiLanguageId | null {
  const language = normalizeLanguage(lang);
  if (isLanguageId(language)) return language;
  return LANGUAGE_ALIASES[language] ?? null;
}

function normalizeLanguage(lang: string): string {
  return lang.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

function isLanguageId(lang: string | null): lang is ShikiLanguageId {
  return typeof lang === 'string' && lang in SHIKI_LANGUAGES;
}

function isLanguageLoaded(highlighter: MangoHighlighter, language: ShikiLanguageId): boolean {
  return highlighter.getLoadedLanguages().includes(language);
}

function loadLanguageOnce(highlighter: MangoHighlighter, language: ShikiLanguageId): Promise<void> {
  if (isLanguageLoaded(highlighter, language)) return Promise.resolve();

  const existing = languageLoadPromises.get(language);
  if (existing) return existing;

  const loading = highlighter.loadLanguage(language).finally(() => {
    languageLoadPromises.delete(language);
  });
  languageLoadPromises.set(language, loading);
  return loading;
}
