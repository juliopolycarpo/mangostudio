import type { Marked } from 'marked';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import type { CodeThemeId } from '@/lib/code-themes';
import { retryStoppedHighlights } from '@/lib/highlight-retry';
import {
  continueHighlightsInSlices,
  HIGHLIGHT_FIRST_SLICE_MS,
  type SlicedBlock,
} from '@/lib/highlight-slices';
import {
  BlockDomMirror,
  IncrementalBlockRenderer,
  IncrementalLexer,
  type MarkdownTokens,
} from '@/lib/markdown-blocks';
import { collectCodeFences, detectCodeLanguages } from '@/lib/markdown-code-languages';
import {
  CLIPBOARD_ICON,
  type CodeHighlighter,
  createParser,
  MARKDOWN_LEXER_OPTIONS,
} from '@/lib/markdown-parser';

const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

export interface MarkdownContentProps {
  content: string;
  className?: string;
  /** Trails the last rendered line with a blinking caret. */
  isStreaming?: boolean;
  copyCodeLabel?: string;
  codeCopiedLabel?: string;
}

/** Renders sanitized markdown once the markdown parser chunk has loaded. */
// Usage: <MarkdownContentRenderer content={message.text} />;
export function MarkdownContentRenderer({
  content,
  className,
  isStreaming = false,
  copyCodeLabel,
  codeCopiedLabel,
}: MarkdownContentProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedCodeTheme } = useTheme();
  const [highlighter, setHighlighter] = useState<CodeHighlighter | null>(null);
  const [highlightVersion, setHighlightVersion] = useState(0);
  // The theme the highlighter has actually loaded. Only that one can colour a
  // block; while a newly chosen theme is on its way, blocks keep the previous
  // colours rather than dropping to plain text.
  const [loadedCodeTheme, setLoadedCodeTheme] = useState<CodeThemeId | null>(null);
  const resolvedCopyLabel = copyCodeLabel ?? t.chat.copyCode;
  const resolvedCopiedLabel = codeCopiedLabel ?? t.chat.codeCopied;
  // Key keeps the array identity stable while the language set is unchanged, so
  // streaming new content does not re-fire the highlighter effect every chunk.
  const tokens = useMarkdownTokens(content);
  const codeLanguageKey = useMemo(() => detectCodeLanguages(tokens.tokens).join('\n'), [tokens]);
  const codeLanguages = useMemo(
    () => (codeLanguageKey ? codeLanguageKey.split('\n') : []),
    [codeLanguageKey]
  );

  useCodeHighlighter(codeLanguages, resolvedCodeTheme, {
    setHighlighter,
    setHighlightVersion,
    setLoadedCodeTheme,
  });
  useCopyCodeButtons(containerRef, resolvedCopyLabel, resolvedCopiedLabel);
  useReleaseSessionsWhenStreamEnds(isStreaming, highlighter);

  const parser = useMemo(
    () => createParser(loadedCodeTheme ?? resolvedCodeTheme, resolvedCopyLabel, highlighter),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The highlighter mutates in place when another language loads.
    [loadedCodeTheme, resolvedCodeTheme, resolvedCopyLabel, highlighter, highlightVersion]
  );
  const blocks = useMarkdownBlocks(tokens, parser);
  useBlocksInContainer(containerRef, blocks);
  useRetryStoppedHighlights({
    tokens,
    parser,
    highlighter,
    theme: loadedCodeTheme ?? resolvedCodeTheme,
    isStreaming,
    onRecovered: () => setHighlightVersion((version) => version + 1),
  });
  useColourRemainingLines({
    containerRef,
    tokens,
    parser,
    highlighter,
    theme: loadedCodeTheme ?? resolvedCodeTheme,
    isStreaming,
    onRedraw: () => setHighlightVersion((version) => version + 1),
  });

  // No React children and no `dangerouslySetInnerHTML`: the blocks are written into the
  // element by `useBlocksInContainer`, which replaces only the blocks a chunk changed.
  // The HTML itself comes from `createParser`'s renderer, which emits a fixed tag set and
  // escapes raw HTML; that is the only path from message text to the DOM.
  return (
    <div
      ref={containerRef}
      className={`markdown-content ${isStreaming ? 'markdown-content--streaming ' : ''}${className ?? ''}`}
    />
  );
}

interface CodeHighlighterSetters {
  readonly setHighlighter: (highlighter: CodeHighlighter) => void;
  readonly setHighlightVersion: React.Dispatch<React.SetStateAction<number>>;
  readonly setLoadedCodeTheme: (theme: CodeThemeId) => void;
}

function useCodeHighlighter(
  languages: readonly string[],
  theme: CodeThemeId,
  { setHighlighter, setHighlightVersion, setLoadedCodeTheme }: CodeHighlighterSetters
) {
  useEffect(() => {
    if (languages.length === 0) return;

    let cancelled = false;
    void loadCodeHighlighter(languages, theme).then(
      (highlighter) => {
        if (cancelled) return;
        setHighlighter(highlighter);
        setLoadedCodeTheme(theme);
        setHighlightVersion((version) => version + 1);
      },
      () => {
        // Keep escaped plain code when initialization or a language download fails.
      }
    );

    return () => {
      cancelled = true;
    };
  }, [languages, theme, setHighlighter, setHighlightVersion, setLoadedCodeTheme]);
}

/** A finished message's blocks are final, so the per-line state kept for them while it grew can go. */
function useReleaseSessionsWhenStreamEnds(
  isStreaming: boolean,
  highlighter: CodeHighlighter | null
) {
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) highlighter?.releaseHighlightSessions?.();
    wasStreaming.current = isStreaming;
  }, [isStreaming, highlighter]);
}

interface StoppedHighlightRetry {
  readonly tokens: MarkdownTokens;
  /** The parser that rendered the blocks on screen: a new one is a new render, whose stops are new. */
  readonly parser: Marked;
  readonly highlighter: CodeHighlighter | null;
  readonly theme: CodeThemeId;
  readonly isStreaming: boolean;
  readonly onRecovered: () => void;
}

/**
 * Draws a block again once, after yielding, when the highlighter stopped it on its time limit.
 * A cold grammar compiles its rules inside the first block that uses them, so that block can
 * stop on a slow or busy machine and tokenize in milliseconds right after; nothing else would
 * render it again, because a finished message does not change.
 *
 * Not while streaming: the next chunk renders the growing block anyway, and the stream's end
 * runs this with the final content. A content or theme change cancels what is pending, and so
 * does unmount. The highlighter keeps the per-block count that stops at two attempts.
 */
function useRetryStoppedHighlights({
  tokens,
  parser,
  highlighter,
  theme,
  isStreaming,
  onRecovered,
}: StoppedHighlightRetry) {
  // The latest callback, without making a new render of the parent cancel a pending retry.
  const onRecoveredRef = useRef(onRecovered);
  useEffect(() => {
    onRecoveredRef.current = onRecovered;
  });

  useEffect(() => {
    if (isStreaming || !highlighter?.isHighlightRetryPending) return;
    const { isHighlightRetryPending, highlightCode } = highlighter;
    const retries = collectCodeFences(tokens.tokens)
      .filter((fence) => isHighlightRetryPending(fence.text, fence.lang, theme))
      .map(
        (fence) => () =>
          highlightCode(fence.text, fence.lang, theme, { budgetMs: HIGHLIGHT_FIRST_SLICE_MS }) !==
          null
      );
    if (retries.length === 0) return;
    return retryStoppedHighlights(retries, () => onRecoveredRef.current());
    // `parser` is not read: it marks a render, and the stops it left are read from the highlighter.
  }, [tokens, parser, highlighter, theme, isStreaming]);
}

interface RemainingLinesColouring {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly tokens: MarkdownTokens;
  /** The parser that rendered the blocks on screen: a new one draws them again, from the start. */
  readonly parser: Marked;
  readonly highlighter: CodeHighlighter | null;
  readonly theme: CodeThemeId;
  readonly isStreaming: boolean;
  readonly onRedraw: () => void;
}

/**
 * Colours what a large code block's first draw left plain. The first draw colours about 25 ms
 * of lines (`HIGHLIGHT_FIRST_SLICE_MS`) and the rest follows in idle slices, each written into
 * its own block, so a 2,000-line block is never one long task and the message around it is not
 * drawn again. A content or theme change cancels what is pending, and so does unmount: the
 * blocks on screen are then not the ones the slices were made for.
 *
 * Not while streaming: the next chunk draws the growing block again, and the stream's end runs
 * this with the final content.
 */
function useColourRemainingLines({
  containerRef,
  tokens,
  parser,
  highlighter,
  theme,
  isStreaming,
  onRedraw,
}: RemainingLinesColouring) {
  // The latest callback, without making a new render of the parent cancel a pending slice.
  const onRedrawRef = useRef(onRedraw);
  useEffect(() => {
    onRedrawRef.current = onRedraw;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (isStreaming || !container) return;
    const blocks = pendingSlicedBlocks(container, tokens, highlighter, theme);
    if (blocks.length === 0) return;
    return continueHighlightsInSlices(blocks, () => onRedrawRef.current());
    // `parser` is not read: it marks a render, and what that render left partial is read from the highlighter.
  }, [containerRef, tokens, parser, highlighter, theme, isStreaming]);
}

/**
 * The fenced blocks on screen with lines left to colour, each with the `<pre>` that shows it.
 * Fences and `pre[data-lang]` elements are both in document order and one-to-one: the renderer
 * escapes raw HTML, so nothing else in a message makes one. A block with no element here is
 * given a detached one, which a slice cannot be written into, so it is drawn again at the end.
 */
function pendingSlicedBlocks(
  container: HTMLElement,
  tokens: MarkdownTokens,
  highlighter: CodeHighlighter | null,
  theme: CodeThemeId
): SlicedBlock[] {
  if (!highlighter?.isHighlightContinuationPending || !highlighter.continueHighlight) return [];
  const { isHighlightContinuationPending, continueHighlight, isHighlightRetryPending } =
    highlighter;
  const elements = container.querySelectorAll('pre[data-lang]');
  return collectCodeFences(tokens.tokens).flatMap((fence, index) =>
    isHighlightContinuationPending(fence.text, fence.lang, theme)
      ? [
          {
            pre: elements[index] ?? container.ownerDocument.createElement('pre'),
            advance: (budgetMs: number, fromLine: number) =>
              continueHighlight(fence.text, fence.lang, theme, budgetMs, fromLine),
            isPending: () => isHighlightContinuationPending(fence.text, fence.lang, theme),
            canRetryAfterStop: () =>
              isHighlightRetryPending?.(fence.text, fence.lang, theme) ?? false,
          },
        ]
      : []
  );
}

function useCopyCodeButtons(
  containerRef: React.RefObject<HTMLDivElement | null>,
  copyCodeLabel: string,
  codeCopiedLabel: string
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pendingResetTimers = new Set<ReturnType<typeof setTimeout>>();
    const handleClick = createCopyClickHandler(pendingResetTimers, copyCodeLabel, codeCopiedLabel);

    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
      for (const timer of pendingResetTimers) clearTimeout(timer);
    };
  }, [containerRef, copyCodeLabel, codeCopiedLabel]);
}

/**
 * The top-level tokens of `content`. The lexer keeps the previous text's tokens and lexes only
 * what a longer text can have changed, so a streamed chunk costs the tail, not the message.
 * Both the language scan and the renderer read these, so the text is lexed once.
 */
function useMarkdownTokens(content: string): MarkdownTokens {
  const lexer = useMemo(() => new IncrementalLexer(MARKDOWN_LEXER_OPTIONS), []);
  return useMemo(() => lexer.update(content), [lexer, content]);
}

/**
 * The HTML of each top-level block. A new parser (another theme, a language that just loaded)
 * starts a new renderer, so nothing rendered by the old one is reused.
 */
function useMarkdownBlocks(tokens: MarkdownTokens, parser: Marked): readonly string[] {
  const renderer = useMemo(() => new IncrementalBlockRenderer(parser), [parser]);
  return useMemo(() => renderer.render(tokens), [renderer, tokens]);
}

/**
 * Writes `blocks` into the container before paint, replacing only the blocks that differ from
 * the last write. A streamed chunk therefore touches the tail block's nodes and leaves the
 * rest of the message, and any selection inside it, alone.
 */
function useBlocksInContainer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  blocks: readonly string[]
) {
  const mirrorRef = useRef<BlockDomMirror | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (mirrorRef.current?.container !== container) {
      container.replaceChildren();
      mirrorRef.current = new BlockDomMirror(container);
    }
    mirrorRef.current.sync(blocks);
  }, [containerRef, blocks]);
}

async function loadCodeHighlighter(
  languages: readonly string[],
  theme: CodeThemeId
): Promise<CodeHighlighter> {
  const highlighter = await import('@/lib/shiki');
  await highlighter.preloadCodeLanguages(languages, theme);
  return highlighter;
}

function createCopyClickHandler(
  pendingResetTimers: Set<ReturnType<typeof setTimeout>>,
  copyCodeLabel: string,
  codeCopiedLabel: string
) {
  return (event: MouseEvent) => {
    void copyCodeFromClick(event, pendingResetTimers, copyCodeLabel, codeCopiedLabel);
  };
}

async function copyCodeFromClick(
  event: MouseEvent,
  pendingResetTimers: Set<ReturnType<typeof setTimeout>>,
  copyCodeLabel: string,
  codeCopiedLabel: string
) {
  const button = (event.target as HTMLElement).closest('.copy-code-btn');
  if (!button) return;

  const text = getCodeBlockText(button);
  if (text === null) return;
  await writeCodeToClipboard(button, text, pendingResetTimers, copyCodeLabel, codeCopiedLabel);
}

function getCodeBlockText(button: Element): string | null {
  const pre = button.closest('pre');
  if (!pre) return null;

  const code = pre.querySelector('code');
  return code?.textContent ?? pre.textContent ?? '';
}

async function writeCodeToClipboard(
  button: Element,
  text: string,
  pendingResetTimers: Set<ReturnType<typeof setTimeout>>,
  copyCodeLabel: string,
  codeCopiedLabel: string
) {
  try {
    await navigator.clipboard.writeText(text);
    markCopyButtonCopied(button, pendingResetTimers, copyCodeLabel, codeCopiedLabel);
  } catch {
    // Clipboard API can be unavailable in non-secure browser contexts.
  }
}

function markCopyButtonCopied(
  button: Element,
  pendingResetTimers: Set<ReturnType<typeof setTimeout>>,
  copyCodeLabel: string,
  codeCopiedLabel: string
) {
  button.innerHTML = CHECK_ICON;
  button.setAttribute('aria-label', codeCopiedLabel);
  button.classList.add('copy-code-btn--copied');
  trackCopyResetTimer(button, pendingResetTimers, copyCodeLabel);
}

function trackCopyResetTimer(
  button: Element,
  pendingResetTimers: Set<ReturnType<typeof setTimeout>>,
  copyCodeLabel: string
) {
  // Timer ownership stays with the event-delegation effect so timers are
  // cleared on unmount even though the click handler is async.
  // eslint-disable-next-line @eslint-react/web-api-no-leaked-timeout
  const resetTimer = setTimeout(() => {
    pendingResetTimers.delete(resetTimer);
    resetCopyButton(button, copyCodeLabel);
  }, 2000);
  pendingResetTimers.add(resetTimer);
}

function resetCopyButton(button: Element, copyCodeLabel: string) {
  button.innerHTML = CLIPBOARD_ICON;
  button.setAttribute('aria-label', copyCodeLabel);
  button.classList.remove('copy-code-btn--copied');
}
