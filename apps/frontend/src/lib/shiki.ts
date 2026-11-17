import {
  createBundledHighlighter,
  getLastGrammarState,
  type GrammarState,
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
/**
 * The last few highlighted blocks, so a streamed message does not re-render every closed block
 * on each chunk: the whole message is re-parsed per chunk, and a block that has not changed has
 * the same HTML. Most recently used last; only successful results are kept, because a `null`
 * means the language was not loaded yet and the next call may succeed.
 */
const HIGHLIGHT_CACHE_ENTRIES = 16;
/**
 * Memory bound for the cache and for the sessions, each, in characters of HTML (2 bytes each).
 * A block over a quarter of it is not kept: JSON HTML runs to about 16x its source.
 */
const HIGHLIGHT_RETAINED_CHARS = 2_000_000;
const HIGHLIGHT_ENTRY_MAX_CHARS = HIGHLIGHT_RETAINED_CHARS / 4;
const highlightCache = new Map<string, string>();
let highlightCacheChars = 0;

function cacheHighlightedHtml(key: string, html: string): void {
  if (html.length > HIGHLIGHT_ENTRY_MAX_CHARS) return;
  highlightCache.set(key, html);
  highlightCacheChars += html.length;
  while (
    highlightCache.size > HIGHLIGHT_CACHE_ENTRIES ||
    highlightCacheChars > HIGHLIGHT_RETAINED_CHARS
  ) {
    const oldest = highlightCache.entries().next().value;
    if (oldest === undefined) return;
    highlightCache.delete(oldest[0]);
    highlightCacheChars -= oldest[1].length;
  }
}

function highlightCacheKey(language: ShikiLanguageId, theme: CodeThemeId, code: string): string {
  return `${language}\0${theme}\0${code}`;
}

/**
 * A block being tokenized as it grows. A streamed message is re-parsed whole on every chunk, so
 * a block arrives as a longer and longer prefix of itself; tokenizing it from line one each time
 * is quadratic over the stream (39 s for 2,000 lines in 200 chunks). A session keeps the HTML
 * of the lines that are complete and the grammar state after the last of them, so a chunk only
 * tokenizes and serializes its new lines plus the unfinished last one.
 */
interface HighlightSession {
  readonly language: ShikiLanguageId;
  readonly theme: CodeThemeId;
  /** The source of the completed lines, each with its line break: a prefix of every later chunk. */
  completedSource: string;
  /** One serialized line per completed line. */
  readonly completedHtml: string[];
  /** The characters in `completedHtml`, for the memory bound. */
  completedHtmlChars: number;
  /** The grammar state after the last completed line; undefined before the first. */
  state: GrammarState | undefined;
}

const HIGHLIGHT_SESSION_COUNT = 4;
/** Most recently used last. */
const highlightSessions: HighlightSession[] = [];

function takeHighlightSession(
  language: ShikiLanguageId,
  theme: CodeThemeId,
  code: string
): HighlightSession {
  const index = highlightSessions.findIndex(
    (session) =>
      session.language === language &&
      session.theme === theme &&
      code.startsWith(session.completedSource)
  );
  // The longest matching prefix would be ideal, but two blocks sharing a prefix is rare and the
  // worst case is only a re-tokenization from the shared lines.
  const session: HighlightSession = (index === -1
    ? undefined
    : highlightSessions.splice(index, 1)[0]) ?? {
    language,
    theme,
    completedSource: '',
    completedHtml: [],
    completedHtmlChars: 0,
    state: undefined,
  };
  highlightSessions.push(session);
  return session;
}

/** Drops the oldest sessions past the count and memory bounds, and the one in use if it alone is too big. */
function trimHighlightSessions(current: HighlightSession): void {
  if (current.completedHtmlChars > HIGHLIGHT_ENTRY_MAX_CHARS) {
    const index = highlightSessions.indexOf(current);
    if (index !== -1) highlightSessions.splice(index, 1);
  }
  let retained = highlightSessions.reduce((sum, session) => sum + session.completedHtmlChars, 0);
  while (
    highlightSessions.length > HIGHLIGHT_SESSION_COUNT ||
    (retained > HIGHLIGHT_RETAINED_CHARS && highlightSessions.length > 1)
  ) {
    retained -= highlightSessions.shift()?.completedHtmlChars ?? 0;
  }
}

/**
 * Forgets the growing blocks. Called when a message stops streaming: its blocks are final and
 * come from the result cache, so their per-line HTML would only sit in memory.
 */
// Usage: releaseHighlightSessions();
export function releaseHighlightSessions(): void {
  highlightSessions.length = 0;
}

let tokenizedLineObserver: ((line: string) => void) | null = null;

/** Test seam: sees every line the tokenizer is given, until called again with `null`. */
// Usage: observeTokenizedLines((line) => lines.push(line));
export function observeTokenizedLines(observer: ((line: string) => void) | null): void {
  tokenizedLineObserver = observer;
}

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
    checkedRenderers = createCheckedRenderers(highlighter, (line) => tokenizedLineObserver?.(line));
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
 *
 * A block that is a longer prefix of an earlier call (a streaming message) only tokenizes its
 * new lines; see `HighlightSession`.
 */
// Usage: const html = highlightCode('const x = 1;', 'ts', 'one-dark-pro');
export function highlightCode(code: string, lang: string, theme: CodeThemeId): string | null {
  const language = resolveLanguageId(lang);
  if (!highlighterInstance || !language) return null;
  if (!isLanguageLoaded(highlighterInstance, language)) return null;

  const key = highlightCacheKey(language, theme, code);
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }

  try {
    const html = renderHighlightedBlock(code, language, theme);
    if (html === null) return null;
    cacheHighlightedHtml(key, html);
    return html;
  } catch {
    return null;
  }
}

function renderHighlightedBlock(
  code: string,
  language: ShikiLanguageId,
  theme: CodeThemeId
): string | null {
  if (!checkedRenderers || !highlighterInstance) return null;
  const renderers = checkedRenderers;
  const instance = highlighterInstance;
  const tokenize = (text: string, state: GrammarState | undefined) =>
    renderers.codeToTokensBase(text, {
      lang: language,
      theme,
      grammarState: state,
      tokenizeTimeLimit: 500,
    });

  const lines = splitLines(code);
  const highlightable = countHighlightableLines(code, language);
  // Nothing to colour: the caller's escaped source is the same text without the empty wrapper.
  if (highlightable === 0) return null;
  // Every line but the last has its line break, so its tokens are final.
  const completeCount = Math.min(lines.length - 1, highlightable);
  const session = takeHighlightSession(language, theme, code);

  const htmlOptions = { lang: language, theme };

  // A throw below leaves the session as it was: it is only updated once its lines exist.
  if (session.completedHtml.length < completeCount) {
    const newLines = lines.slice(session.completedHtml.length, completeCount);
    const tokens = tokenize(newLines.map(([text]) => text).join('\n'), session.state);
    const newHtml = renderers.tokenLinesToHtml(tokens, htmlOptions);
    session.completedHtml.push(...newHtml);
    session.completedHtmlChars += newHtml.reduce((sum, line) => sum + line.length, 0);
    session.state = getLastGrammarState(instance, tokens);
    session.completedSource = code.slice(0, lines[completeCount]?.[1]);
  }
  trimHighlightSessions(session);

  // Lines after the completed ones are drawn again on every call: the last line may still be
  // arriving, so it is tokenized from the saved state and not kept; lines past the budget are plain.
  const openTokens: ThemedToken[][] = [];
  if (highlightable > completeCount) {
    openTokens.push(...tokenize(lines[completeCount]?.[0] ?? '', session.state));
  }
  for (
    let index = session.completedHtml.length + openTokens.length;
    index < lines.length;
    index++
  ) {
    const text = lines[index]?.[0] ?? '';
    openTokens.push(text ? [{ content: text, offset: 0 }] : []);
  }
  return renderers.htmlFromLines(
    [...session.completedHtml, ...renderers.tokenLinesToHtml(openTokens, htmlOptions)],
    htmlOptions
  );
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
    // A block may embed this grammar (a python fence in markdown), so earlier HTML is stale.
    highlightCache.clear();
    highlightCacheChars = 0;
    highlightSessions.length = 0;
  });
  languageLoadPromises.set(language, loading);
  return loading;
}
