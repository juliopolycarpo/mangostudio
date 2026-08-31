import { Marked, Renderer } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import type { CodeThemeId } from '@/lib/code-themes';

const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

interface CodeHighlighter {
  highlightCode: (code: string, lang: string, theme: CodeThemeId) => string | null;
  preloadCodeLanguages: (languages: readonly string[]) => Promise<boolean>;
}

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
  const resolvedCopyLabel = copyCodeLabel ?? t.chat.copyCode;
  const resolvedCopiedLabel = codeCopiedLabel ?? t.chat.codeCopied;
  // Key keeps the array identity stable while the language set is unchanged, so
  // streaming new content does not re-fire the highlighter effect every chunk.
  const codeLanguageKey = useMemo(() => detectCodeLanguages(content).join('\n'), [content]);
  const codeLanguages = useMemo(
    () => (codeLanguageKey ? codeLanguageKey.split('\n') : []),
    [codeLanguageKey]
  );

  useCodeHighlighter(codeLanguages, setHighlighter, setHighlightVersion);
  useCopyCodeButtons(containerRef, resolvedCopyLabel, resolvedCopiedLabel);

  const parser = useMemo(
    () => createParser(resolvedCodeTheme, resolvedCopyLabel, highlighter),
    [resolvedCodeTheme, resolvedCopyLabel, highlighter, highlightVersion]
  );
  // The memo re-parses whenever content or parser changes (i.e. every streamed
  // chunk), so it already reflects the latest content without a second parse.
  const renderedHtml = useParsedMarkdown(content, parser);

  return (
    <div
      ref={containerRef}
      className={`markdown-content ${isStreaming ? 'markdown-content--streaming ' : ''}${className ?? ''}`}
      // HTML is produced by `marked` with a custom renderer that only emits
      // a fixed tag set and escapes raw HTML; rendering as HTML is required
      // to surface Shiki-highlighted code blocks and safe link elements.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized markdown is rendered as HTML here
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}

function useCodeHighlighter(
  languages: readonly string[],
  setHighlighter: (highlighter: CodeHighlighter) => void,
  setHighlightVersion: React.Dispatch<React.SetStateAction<number>>
) {
  useEffect(() => {
    if (languages.length === 0) return;

    let cancelled = false;
    void loadCodeHighlighter(languages).then((highlighter) => {
      if (cancelled) return;
      setHighlighter(highlighter);
      setHighlightVersion((version) => version + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [languages, setHighlighter, setHighlightVersion]);
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

function useParsedMarkdown(content: string, parser: Marked): string {
  return useMemo(() => parseMarkdown(parser, content), [content, parser]);
}

function createParser(
  theme: CodeThemeId,
  copyCodeLabel: string,
  highlighter: CodeHighlighter | null
): Marked {
  return new Marked({
    gfm: true,
    breaks: true,
    renderer: createRenderer(theme, copyCodeLabel, highlighter),
  });
}

function createRenderer(
  theme: CodeThemeId,
  copyCodeLabel: string,
  highlighter: CodeHighlighter | null
): Renderer {
  const renderer = new Renderer();
  renderer.link = renderLink;
  renderer.image = renderImage;
  renderer.html = (token) => escapeHtml('text' in token ? token.text : '');
  renderer.code = (token) => renderCode(token.text, token.lang, theme, copyCodeLabel, highlighter);
  return renderer;
}

/**
 * Renders a link whose href *and* body are both inert.
 *
 * Child tokens are flattened to their source text and escaped: the result is
 * interpolated into the same `dangerouslySetInnerHTML` string as everything
 * else, so unescaped label text is live markup — `[x<img src=y onerror=…>](…)`
 * is a script-execution path that a safe href does nothing to close.
 * // Usage: renderLink({ href: 'https://a.example', tokens: [] })
 */
function renderLink({ href, title, tokens }: Parameters<Renderer['link']>[0]): string {
  const text =
    tokens
      ?.map((token): string => escapeHtml('text' in token ? (token.text as string) : token.raw))
      .join('') ?? '';
  const safeHref = safeMarkdownUrl(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
}

function renderImage({ href, title, text }: Parameters<Renderer['image']>[0]): string {
  const safeHref = safeMarkdownUrl(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  const body = text || safeHref;
  return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer" class="markdown-image-link"${titleAttr}>${escapeHtml(body)}</a>`;
}

// Schemes the chat renderer may turn into a clickable target. Anything else
// (javascript:, data:, vbscript:, …) is neutralized to a harmless anchor.
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const UNSAFE_URL_FALLBACK = '#';
// Base only used to resolve scheme-less relative hrefs so they classify as safe;
// the original href is always what gets rendered, never this base.
const RELATIVE_URL_BASE = 'https://markdown.invalid/';

/**
 * Returns `href` when it is a safe link target, otherwise '#'.
 *
 * Parsing with the WHATWG `URL` API strips smuggled tabs/newlines and
 * normalizes scheme casing, so only http(s)/mailto absolute URLs and
 * scheme-less relative URLs survive. // Usage: safeMarkdownUrl('javascript:alert(1)') === '#'
 */
function safeMarkdownUrl(href: string | null | undefined): string {
  if (!href) return UNSAFE_URL_FALLBACK;
  let protocol: string;
  try {
    protocol = new URL(href, RELATIVE_URL_BASE).protocol;
  } catch {
    return UNSAFE_URL_FALLBACK;
  }
  return SAFE_LINK_PROTOCOLS.has(protocol) ? href : UNSAFE_URL_FALLBACK;
}

function renderCode(
  text: string,
  lang: string | undefined,
  theme: CodeThemeId,
  copyCodeLabel: string,
  highlighter: CodeHighlighter | null
): string {
  const safeLang = lang ?? '';
  const highlighted = safeLang ? highlighter?.highlightCode(text, safeLang, theme) : null;
  if (highlighted) return renderHighlightedCode(highlighted, safeLang, copyCodeLabel);

  return renderPlainCode(text, safeLang, copyCodeLabel);
}

function renderHighlightedCode(html: string, lang: string, copyCodeLabel: string): string {
  return html
    .replace('<pre ', `<pre data-lang="${escapeHtml(lang)}" `)
    .replace('</pre>', `${copyButton(copyCodeLabel)}</pre>`);
}

function renderPlainCode(text: string, lang: string, copyCodeLabel: string): string {
  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
  return `<pre${langAttr}><code${langClass}>${escapeHtml(text)}</code>${copyButton(copyCodeLabel)}</pre>`;
}

function parseMarkdown(parser: Marked, content: string): string {
  if (!content) return '';
  return parser.parse(content, { async: false });
}

// Reused across calls; the lexer keeps no per-document state worth resetting.
const codeLanguageLexer = new Marked({ gfm: true, breaks: true });

function detectCodeLanguages(content: string): string[] {
  if (!content) return [];

  const languages = new Set<string>();
  // walkTokens recurses into list items and blockquotes, so fenced code nested
  // inside them still has its grammar preloaded for highlighting.
  codeLanguageLexer.walkTokens(codeLanguageLexer.lexer(content), (token) => {
    if (token.type === 'code' && 'lang' in token && token.lang) languages.add(token.lang);
  });
  return [...languages].sort();
}

async function loadCodeHighlighter(languages: readonly string[]): Promise<CodeHighlighter> {
  const highlighter = await import('@/lib/shiki');
  await highlighter.preloadCodeLanguages(languages);
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

function copyButton(ariaLabel: string): string {
  return `<button class="copy-code-btn" type="button" aria-label="${escapeHtml(ariaLabel)}">${CLIPBOARD_ICON}</button>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
