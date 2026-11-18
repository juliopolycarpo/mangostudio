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
import {
  groupedLinesHtml,
  HIGHLIGHT_CATCH_UP_LINES,
  HIGHLIGHT_GROUP_LINES,
  type HighlightSlice,
  isGroupedBlock,
} from '@/lib/highlight-slices';
import { createCheckedRenderers, IncompleteTokenizationError } from '@/lib/shiki-checked-render';

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
 * Where a block, or a diff line, that stopped on the tokenizer's time limit stands.
 *
 * The stop is not always the content's fault: the JavaScript regex engine compiles a grammar
 * rule on the first line that reaches it, which takes 140 ms on an idle machine and seconds
 * under CPU load, and the same text takes a few milliseconds afterwards. So the first stop is a
 * `retry-pending`: the consumer yields and asks again (`isHighlightRetryPending`). A retry that
 * finishes leaves the entry `recovered`, not deleted: if a later render of the same content
 * stops again, the machine is busy, and that stop is `gave-up` rather than a new retry-pending
 * (which would loop: stop, retry, colour, redraw, stop). A second stop is also `gave-up`: the
 * content is one the limit is meant to refuse, and it is drawn plain without being tokenized
 * again, so a block costs at most two capped attempts. Size-limit refusals and engine failures
 * never get an entry.
 *
 * `gave-up` is not for the session: a block that stopped twice in a busy window is worth a
 * fresh pair of attempts once `GAVE_UP_TTL_MS` has passed, when it is next drawn (a remount).
 */
type TimeStopState = 'retry-pending' | 'recovered' | 'gave-up';
interface TimeStopEntry {
  readonly state: TimeStopState;
  /** `timeStopClock()` when the entry was written. */
  readonly at: number;
}
const TIME_STOP_ENTRIES = 64;
const GAVE_UP_TTL_MS = 30_000;
/** Oldest first; a streamed block leaves one entry per prefix that stopped, so it is bounded. */
const timeStops = new Map<string, TimeStopEntry>();
/**
 * The tokens of diff lines a retry coloured, so the redraw that follows reads them and does not
 * tokenize the line a third time. Only recovered lines: an ordinary line is memoized by its row.
 */
const LINE_RECOVERY_ENTRIES = 256;
const recoveredLineTokens = new Map<string, readonly HighlightToken[]>();

/** Not `Date.now`: the tokenizer's limit reads that one, and tests drive it to cause a stop. */
let timeStopClock: () => number = () => performance.now();

/** Test seam: replaces the clock `gave-up` expires on, until called again with `null`. */
// Usage: setTimeStopClock(() => fakeNowMs);
export function setTimeStopClock(clock: (() => number) | null): void {
  timeStopClock = clock ?? (() => performance.now());
}

function lineStopKey(language: ShikiLanguageId, theme: CodeThemeId, line: string): string {
  return `line\0${highlightCacheKey(language, theme, line)}`;
}

function writeTimeStop(key: string, state: TimeStopState): void {
  timeStops.delete(key);
  timeStops.set(key, { state, at: timeStopClock() });
  while (timeStops.size > TIME_STOP_ENTRIES) {
    const oldest = timeStops.keys().next().value;
    if (oldest === undefined) return;
    timeStops.delete(oldest);
  }
}

function recordTimeStop(key: string, error: unknown): void {
  if (!(error instanceof IncompleteTokenizationError)) return;
  writeTimeStop(key, timeStops.has(key) ? 'gave-up' : 'retry-pending');
}

function rememberRecoveredLine(key: string, tokens: readonly HighlightToken[]): void {
  recoveredLineTokens.delete(key);
  recoveredLineTokens.set(key, tokens);
  while (recoveredLineTokens.size > LINE_RECOVERY_ENTRIES) {
    const oldest = recoveredLineTokens.keys().next().value;
    if (oldest === undefined) return;
    recoveredLineTokens.delete(oldest);
  }
}

/** A draw that finished: an earlier stop is now `recovered`; a block that never stopped gets no entry. */
function recordCompletion(key: string): void {
  if (timeStops.has(key)) writeTimeStop(key, 'recovered');
}

/** True while a block that stopped twice is refused; once the entry is old, forgets it. */
function isGivenUp(key: string): boolean {
  const entry = timeStops.get(key);
  if (entry?.state !== 'gave-up') return false;
  if (timeStopClock() - entry.at < GAVE_UP_TTL_MS) return true;
  timeStops.delete(key);
  return false;
}

/**
 * True when `code` in this language stopped once on the time limit and has not been asked for
 * since, so asking again after yielding may colour it. Streaming consumers ask once the
 * message is done: while it grows, the next chunk renders the block again anyway.
 */
// Usage: if (isHighlightRetryPending(code, 'ts', 'one-dark-pro')) scheduleRetry();
export function isHighlightRetryPending(code: string, lang: string, theme: CodeThemeId): boolean {
  const language = resolveLanguageId(lang);
  if (!language) return false;
  return timeStops.get(highlightCacheKey(language, theme, code))?.state === 'retry-pending';
}

/** The same for a line drawn by `highlightLineTokens`. */
// Usage: if (isLineHighlightRetryPending(line, 'ts', 'one-dark-pro')) scheduleRetry();
export function isLineHighlightRetryPending(
  line: string,
  lang: string,
  theme: CodeThemeId
): boolean {
  const language = resolveLanguageId(lang);
  if (!language) return false;
  return timeStops.get(lineStopKey(language, theme, line))?.state === 'retry-pending';
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
  /**
   * Complete lines the last call left uncoloured because its time budget ran out. A session with
   * work left is unfinished: it is kept when released, and is not dropped for its size, because
   * dropping it would send the next slice back to line one.
   */
  pendingLines: number;
}

const HIGHLIGHT_SESSION_COUNT = 4;
/** Most recently used last. */
const highlightSessions: HighlightSession[] = [];

/**
 * Lines tokenized between two reads of the clock when a call has a time budget. The budget is
 * only checked between batches, so a slice overshoots it by at most one batch: about 8 ms for 16
 * lines of TypeScript in Chromium (0.5 ms a line; Bun is about four times faster). A batch is
 * one group of a long block, so a slice swaps whole groups.
 */
const SLICE_BATCH_LINES = HIGHLIGHT_GROUP_LINES;

/**
 * A call with a time budget colours this many lines, or fewer, in one go. A short block is
 * coloured at once, with no plain-then-coloured flash, and the last stretch of a long one lands
 * in a single slice of about 30 ms and not in several tiny ones.
 */
const UNSLICED_LINES = 64;

function findHighlightSession(language: ShikiLanguageId, theme: CodeThemeId, code: string): number {
  return highlightSessions.findIndex(
    (session) =>
      session.language === language &&
      session.theme === theme &&
      code.startsWith(session.completedSource)
  );
}

function takeHighlightSession(
  language: ShikiLanguageId,
  theme: CodeThemeId,
  code: string
): HighlightSession {
  const index = findHighlightSession(language, theme, code);
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
    pendingLines: 0,
  };
  highlightSessions.push(session);
  return session;
}

/** Drops the oldest sessions past the count and memory bounds, and the one in use if it alone is too big. */
function trimHighlightSessions(current: HighlightSession): void {
  if (current.completedHtmlChars > HIGHLIGHT_ENTRY_MAX_CHARS && current.pendingLines === 0) {
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
 * come from the result cache, so their per-line HTML would only sit in memory. A block that is
 * still being coloured in slices keeps its session, so its next slice carries on.
 */
// Usage: releaseHighlightSessions();
export function releaseHighlightSessions(): void {
  const unfinished = highlightSessions.filter((session) => session.pendingLines > 0);
  highlightSessions.length = 0;
  highlightSessions.push(...unfinished);
}

/**
 * Blocks last drawn with only their first lines coloured, because the call that drew them had a
 * time budget. `isHighlightContinuationPending` reads it. It is a set of keys and not a look at
 * the sessions, which are evicted by count: a message with many large blocks must still colour
 * the ones whose session is gone (they start again from their first line). Oldest first.
 */
const PARTIAL_BLOCK_ENTRIES = 64;
const partialBlocks = new Set<string>();

function markPartialBlock(key: string, partial: boolean): void {
  partialBlocks.delete(key);
  if (!partial) return;
  partialBlocks.add(key);
  while (partialBlocks.size > PARTIAL_BLOCK_ENTRIES) {
    const oldest = partialBlocks.values().next().value;
    if (oldest === undefined) return;
    partialBlocks.delete(oldest);
  }
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
 *
 * A block the tokenizer stops on its time limit returns `null` like any plain block, but is
 * remembered: `isHighlightRetryPending` says whether asking again may colour it, and a second
 * stop ends the attempts (`TimeStopState`).
 *
 * With `options.budgetMs` the call colours lines for about that long and draws the rest plain
 * (`HighlightSlice` explains the rest). Without it the call colours the whole block.
 */
// Usage: const html = highlightCode('const x = 1;', 'ts', 'one-dark-pro');
export function highlightCode(
  code: string,
  lang: string,
  theme: CodeThemeId,
  options: { readonly budgetMs?: number } = {}
): string | null {
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

  // Stopped twice: a block the limit refuses, not tokenized a third time (until it expires).
  if (isGivenUp(key)) return null;

  try {
    const block = renderHighlightedBlock(code, language, theme, options.budgetMs);
    recordCompletion(key);
    if (block === null) return null;
    // A block with lines still to colour is not the final HTML for this source: a cached copy
    // would be served to every later call and the rest would never be coloured.
    markPartialBlock(key, !block.complete);
    if (block.complete) cacheHighlightedHtml(key, block.html);
    return block.html;
  } catch (error) {
    recordTimeStop(key, error);
    return null;
  }
}

/** What `highlightCode` knows about a block before it tokenizes any of it. */
interface BlockPlan {
  readonly lines: ReturnType<typeof splitLines>;
  /** Complete lines (those with their line break) that are coloured when the block is finished. */
  readonly completeCount: number;
  /** Lines inside the highlighting budget: all of them, or the ones before the first over-limit line. */
  readonly highlightable: number;
}

/** Null when no line of the block is coloured, so the caller's escaped source is used. */
function planBlock(code: string, language: ShikiLanguageId): BlockPlan | null {
  const lines = splitLines(code);
  const highlightable = countHighlightableLines(code, language);
  if (highlightable === 0) return null;
  // Every line but the last has its line break, so its tokens are final.
  return { lines, highlightable, completeCount: Math.min(lines.length - 1, highlightable) };
}

interface BlockRendering {
  readonly renderers: ReturnType<typeof createCheckedRenderers>;
  readonly instance: MangoHighlighter;
  readonly htmlOptions: { readonly lang: ShikiLanguageId; readonly theme: CodeThemeId };
  readonly tokenize: (text: string, state: GrammarState | undefined) => ThemedToken[][];
}

function blockRendering(language: ShikiLanguageId, theme: CodeThemeId): BlockRendering | null {
  const renderers = checkedRenderers;
  const instance = highlighterInstance;
  if (!renderers || !instance) return null;
  return {
    renderers,
    instance,
    htmlOptions: { lang: language, theme },
    tokenize: (text, state) =>
      renderers.codeToTokensBase(text, {
        lang: language,
        theme,
        grammarState: state,
        tokenizeTimeLimit: 500,
      }),
  };
}

/**
 * Colours the session's next complete lines until `budgetMs` has passed (checked between
 * batches), or all of them when there is no budget. Each batch is stored as it lands, so a throw
 * in a later one keeps the lines before it. Leaves `session.pendingLines` at what is still to do.
 */
function advanceSession(
  rendering: BlockRendering,
  session: HighlightSession,
  code: string,
  plan: BlockPlan,
  budgetMs: number | undefined
): void {
  const spendable =
    plan.completeCount - session.completedHtml.length > UNSLICED_LINES ? budgetMs : undefined;
  const deadline = spendable === undefined ? Number.POSITIVE_INFINITY : timeStopClock() + spendable;
  while (session.completedHtml.length < plan.completeCount) {
    const from = session.completedHtml.length;
    const to =
      spendable === undefined
        ? plan.completeCount
        : Math.min(plan.completeCount, from + SLICE_BATCH_LINES);
    const tokens = rendering.tokenize(
      plan.lines
        .slice(from, to)
        .map(([text]) => text)
        .join('\n'),
      session.state
    );
    const newHtml = rendering.renderers.tokenLinesToHtml(tokens, rendering.htmlOptions);
    session.completedHtml.push(...newHtml);
    session.completedHtmlChars += newHtml.reduce((sum, line) => sum + line.length, 0);
    session.state = getLastGrammarState(rendering.instance, tokens);
    session.completedSource = code.slice(0, plan.lines[to]?.[1]);
    if (timeStopClock() >= deadline) break;
  }
  session.pendingLines = plan.completeCount - session.completedHtml.length;
}

/**
 * The last line of a finished block, coloured from the saved state. It is drawn again on every
 * call and never kept, because it may still be arriving. Empty while complete lines are left:
 * the state it needs is not known yet, and it is drawn plain.
 */
function openLineHtml(
  rendering: BlockRendering,
  session: HighlightSession,
  plan: BlockPlan
): string[] {
  if (session.pendingLines > 0 || plan.highlightable <= plan.completeCount) return [];
  const tokens = rendering.tokenize(plan.lines[plan.completeCount]?.[0] ?? '', session.state);
  return rendering.renderers.tokenLinesToHtml(tokens, rendering.htmlOptions);
}

/** The lines from `fromLine` on drawn as plain text: the ones not reached yet and the ones past the budget. */
function plainLinesHtml(rendering: BlockRendering, plan: BlockPlan, fromLine: number): string[] {
  const tokens: ThemedToken[][] = [];
  for (let index = fromLine; index < plan.lines.length; index++) {
    const text = plan.lines[index]?.[0] ?? '';
    tokens.push(text ? [{ content: text, offset: 0 }] : []);
  }
  return rendering.renderers.tokenLinesToHtml(tokens, rendering.htmlOptions);
}

/** The whole block around its serialized lines: flat, or in groups when it is long (`isGroupedBlock`). */
function blockHtml(rendering: BlockRendering, lines: readonly string[]): string {
  return rendering.renderers.htmlFromLines(
    isGroupedBlock(lines.length) ? [groupedLinesHtml(lines)] : lines,
    rendering.htmlOptions
  );
}

function renderHighlightedBlock(
  code: string,
  language: ShikiLanguageId,
  theme: CodeThemeId,
  budgetMs: number | undefined
): { readonly html: string; readonly complete: boolean } | null {
  const rendering = blockRendering(language, theme);
  const plan = planBlock(code, language);
  // Nothing to colour: the caller's escaped source is the same text without the empty wrapper.
  if (!rendering || !plan) return null;
  const session = takeHighlightSession(language, theme, code);

  // A throw below leaves the session as it was: it is only updated once its lines exist.
  advanceSession(rendering, session, code, plan, budgetMs);
  trimHighlightSessions(session);

  // Lines after the completed ones are drawn again on every call; see `openLineHtml`.
  const openHtml = openLineHtml(rendering, session, plan);
  const trailing = [
    ...openHtml,
    ...plainLinesHtml(rendering, plan, session.completedHtml.length + openHtml.length),
  ];
  return {
    html: blockHtml(rendering, [...session.completedHtml, ...trailing]),
    complete: session.pendingLines === 0,
  };
}

/**
 * True when `highlightCode` drew this block with a budget and left lines uncoloured, so
 * `continueHighlight` has more to do. False for a block that was never drawn that way, one that
 * is finished (it is in the result cache), and one the tokenizer stopped on its time limit
 * (`isHighlightRetryPending` owns that).
 */
// Usage: if (isHighlightContinuationPending(code, 'ts', 'one-dark-pro')) scheduleSlices();
export function isHighlightContinuationPending(
  code: string,
  lang: string,
  theme: CodeThemeId
): boolean {
  const language = resolveLanguageId(lang);
  if (!language) return false;
  const key = highlightCacheKey(language, theme, code);
  // A block that gave up stays in `partialBlocks` but `continueHighlight` refuses it, so a caller
  // that asked again would schedule a slice that does nothing.
  return partialBlocks.has(key) && !isGivenUp(key) && timeStops.get(key)?.state !== 'retry-pending';
}

/**
 * Colours the next stretch of a block `highlightCode` drew partly, for about `budgetMs`, and
 * returns the HTML of the lines that changed so the caller can swap just those on screen. When
 * the block is finished its whole HTML goes into the result cache, so a later draw of it is one
 * lookup. Returns null when there is nothing to continue, or when the tokenizer stopped on its
 * time limit: the stop is recorded as for `highlightCode`, and a retry runs the same call again.
 *
 * `fromLine` is how far the caller's block has been coloured. Blocks with the same text share one
 * session, so another block may have moved it past that: the caller then gets the lines between
 * (up to `HIGHLIGHT_CATCH_UP_LINES`) with no tokenizing, and the session moves only for a caller
 * that is level with it. Without `fromLine` the caller is taken to be level.
 */
// Usage: const slice = continueHighlight(code, 'ts', 'one-dark-pro', 25, linesOnScreen);
export function continueHighlight(
  code: string,
  lang: string,
  theme: CodeThemeId,
  budgetMs: number,
  fromLine?: number
): HighlightSlice | null {
  const language = resolveLanguageId(lang);
  if (!highlighterInstance || !language) return null;
  const key = highlightCacheKey(language, theme, code);
  if (!partialBlocks.has(key) || isGivenUp(key)) return null;
  const rendering = blockRendering(language, theme);
  const plan = planBlock(code, language);
  if (!rendering || !plan) return null;

  const session = takeHighlightSession(language, theme, code);
  // Blocks with the same text share this session, so its progress is not the caller's: lines
  // before `fromLine` are the ones the caller's block shows coloured. A caller that is ahead
  // of the session (its lines were dropped) starts at the session's end, which colours lines
  // again and never leaves a gap.
  const start = Math.min(fromLine ?? session.completedHtml.length, session.completedHtml.length);
  try {
    // A caller behind the session is handed lines that are already coloured, without tokenizing.
    const behind = start < session.completedHtml.length;
    if (!behind) {
      advanceSession(rendering, session, code, plan, budgetMs);
      trimHighlightSessions(session);
      recordCompletion(key);
    }
    const end = behind
      ? Math.min(session.completedHtml.length, start + HIGHLIGHT_CATCH_UP_LINES)
      : session.completedHtml.length;
    const reachesEnd = end === session.completedHtml.length;
    const done = reachesEnd && session.pendingLines === 0;
    const openHtml = reachesEnd ? openLineHtml(rendering, session, plan) : [];
    if (done) {
      const trailing = [
        ...openHtml,
        ...plainLinesHtml(rendering, plan, session.completedHtml.length + openHtml.length),
      ];
      cacheHighlightedHtml(key, blockHtml(rendering, [...session.completedHtml, ...trailing]));
      markPartialBlock(key, false);
    }
    return {
      fromLine: start,
      lineHtml: [...session.completedHtml.slice(start, end), ...openHtml],
      lineCount: plan.lines.length,
      done,
    };
  } catch (error) {
    recordTimeStop(key, error);
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

  const key = lineStopKey(language, theme, line);
  const recovered = recoveredLineTokens.get(key);
  if (recovered !== undefined) return recovered;
  if (isGivenUp(key)) return null;
  try {
    const wasRetry = timeStops.get(key)?.state === 'retry-pending';
    const tokens =
      checkedRenderers?.codeToTokensBase(line, {
        lang: language,
        theme,
        tokenizeTimeLimit: 500,
      })[0] ?? [];
    recordCompletion(key);
    if (wasRetry) rememberRecoveredLine(key, tokens);
    return tokens;
  } catch (error) {
    recordTimeStop(key, error);
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
    partialBlocks.clear();
    timeStops.clear();
    recoveredLineTokens.clear();
  });
  languageLoadPromises.set(language, loading);
  return loading;
}
