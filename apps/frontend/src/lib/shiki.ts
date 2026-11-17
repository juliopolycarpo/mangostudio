import {
  createBundledHighlighter,
  type HighlighterGeneric,
  splitLines,
  type ThemedToken,
} from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';

import { countHighlightableLines } from '@/lib/code-highlight-limits';
import { resolveLanguageId, type ShikiLanguageId } from '@/lib/code-languages';
import type { CodeThemeId } from '@/lib/code-themes';
import { createCheckedRenderers } from '@/lib/shiki-checked-render';

export { CODE_THEMES, type CodeThemeId } from '@/lib/code-themes';

// Checked against the id list in `code-languages.ts`: a language in one and not the other fails to compile.
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
} as const satisfies Record<ShikiLanguageId, () => Promise<unknown>>;

const SHIKI_THEMES = {
  'github-dark-dimmed': () => import('@shikijs/themes/github-dark-dimmed'),
  'github-light': () => import('@shikijs/themes/github-light'),
  'one-dark-pro': () => import('@shikijs/themes/one-dark-pro'),
  'one-light': () => import('@shikijs/themes/one-light'),
} as const;

type MangoHighlighter = HighlighterGeneric<ShikiLanguageId, CodeThemeId>;

const createMangoHighlighter = createBundledHighlighter({
  langs: SHIKI_LANGUAGES,
  themes: SHIKI_THEMES,
  engine: () => createJavaScriptRegexEngine(),
});

let highlighterPromise: Promise<MangoHighlighter> | null = null;
let highlighterInstance: MangoHighlighter | null = null;
let checkedRenderers: ReturnType<typeof createCheckedRenderers> | null = null;
const languageLoadPromises = new Map<ShikiLanguageId, Promise<void>>();
const themeLoadPromises = new Map<CodeThemeId, Promise<void>>();

/**
 * Initializes the shared Shiki highlighter with no theme and no grammar.
 *
 * Each grammar and theme is its own chunk (the larger grammars and themes run
 * to tens of KB), and a first fenced block needs one theme and its own
 * language, so `preloadCodeLanguages` fetches exactly those. Starting from the
 * four themes and eight common grammars made one `ts` block cost 22
 * requests.
 */
// Usage: await initHighlighter();
export function initHighlighter(): Promise<MangoHighlighter> {
  highlighterPromise ??= createMangoHighlighter({
    themes: [],
    langs: [],
  }).then((highlighter) => {
    checkedRenderers = createCheckedRenderers(highlighter);
    highlighterInstance = highlighter;
    return highlighter;
  });

  return highlighterPromise;
}

/**
 * Loads the fenced-code languages, and the theme they will be drawn in, before
 * markdown is parsed for highlighting. Resolves `false` when none of the
 * languages is one Shiki can highlight, in which case nothing is fetched.
 * Switching the code theme later only needs another call with the new theme.
 */
// Usage: await preloadCodeLanguages(['typescript', 'rust'], 'one-dark-pro');
export async function preloadCodeLanguages(
  languages: readonly string[],
  theme: CodeThemeId
): Promise<boolean> {
  const languageIds = resolveUniqueLanguageIds(languages);
  if (languageIds.length === 0) return false;

  const highlighter = await initHighlighter();
  await Promise.all([
    loadThemeOnce(highlighter, theme),
    ...languageIds.map((language) => loadLanguageOnce(highlighter, language)),
  ]);
  return true;
}

/**
 * Returns highlighted HTML when the highlighter and language are ready, or `null`
 * when the caller should show the escaped source.
 *
 * Lines are tokenized only up to the budget in `code-highlight-limits`, which is checked
 * before tokenizing: the line that would exceed it and every line after it are drawn plain.
 * They stay plain even if later lines are cheap, because the grammar state after a skipped
 * line is unknown, and colouring what follows from a guessed state could look right and be wrong.
 */
// Usage: const html = highlightCode('const x = 1;', 'ts', 'one-dark-pro');
export function highlightCode(code: string, lang: string, theme: CodeThemeId): string | null {
  const language = resolveLanguageId(lang);
  if (!highlighterInstance || !language) return null;
  if (!isLanguageLoaded(highlighterInstance, language)) return null;

  try {
    return renderHighlightedBlock(code, language, theme);
  } catch {
    return null;
  }
}

function renderHighlightedBlock(
  code: string,
  language: ShikiLanguageId,
  theme: CodeThemeId
): string | null {
  if (!checkedRenderers) return null;
  const renderers = checkedRenderers;
  const lines = splitLines(code);
  const highlightable = countHighlightableLines(code, language);
  // Nothing to colour: the caller's escaped source is the same text without the empty wrapper.
  if (highlightable === 0) return null;

  const tokens: ThemedToken[][] = renderers.codeToTokensBase(
    lines
      .slice(0, highlightable)
      .map(([text]) => text)
      .join('\n'),
    { lang: language, theme, tokenizeTimeLimit: 500 }
  );
  // Lines past the budget are drawn plain, as one uncoloured token each.
  for (let index = tokens.length; index < lines.length; index++) {
    const text = lines[index]?.[0] ?? '';
    tokens.push(text ? [{ content: text, offset: 0 }] : []);
  }
  const htmlOptions = { lang: language, theme };
  return renderers.htmlFromLines(renderers.tokenLinesToHtml(tokens, htmlOptions), htmlOptions);
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
 * A line over `code-highlight-limits` returns `null`, so a diff keeps colouring its
 * other lines.
 * Example: highlightLineTokens('const value = 1;', 'ts', 'one-dark-pro').
 */
export function highlightLineTokens(
  line: string,
  lang: string,
  theme: CodeThemeId
): readonly HighlightToken[] | null {
  const language = resolveLanguageId(lang);
  if (!highlighterInstance || !language) return null;
  if (!isLanguageLoaded(highlighterInstance, language)) return null;
  if (countHighlightableLines(line, language) < 1) return null;

  try {
    return (
      checkedRenderers?.codeToTokensBase(line, {
        lang: language,
        theme,
        tokenizeTimeLimit: 500,
      })[0] ?? []
    );
  } catch {
    return null;
  }
}

function resolveUniqueLanguageIds(languages: readonly string[]): ShikiLanguageId[] {
  return [...new Set(languages.map(resolveLanguageId).filter((language) => language !== null))];
}

function isLanguageLoaded(highlighter: MangoHighlighter, language: ShikiLanguageId): boolean {
  return highlighter.getLoadedLanguages().includes(language);
}

function loadThemeOnce(highlighter: MangoHighlighter, theme: CodeThemeId): Promise<void> {
  if (highlighter.getLoadedThemes().includes(theme)) return Promise.resolve();

  const existing = themeLoadPromises.get(theme);
  if (existing) return existing;

  const loading = highlighter.loadTheme(theme).finally(() => {
    themeLoadPromises.delete(theme);
  });
  themeLoadPromises.set(theme, loading);
  return loading;
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
