import { Marked, type MarkedOptions, Renderer } from 'marked';

import type { CodeThemeId } from '@/lib/code-themes';

export const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

export interface CodeHighlighter {
  highlightCode: (code: string, lang: string, theme: CodeThemeId) => string | null;
  preloadCodeLanguages: (languages: readonly string[], theme: CodeThemeId) => Promise<boolean>;
  /** Frees the per-block state kept while a message streams; absent on a highlighter without any. */
  releaseHighlightSessions?: () => void;
}

/**
 * The markdown parser every chat message goes through. Its renderer is the only path from
 * model text to the HTML the chat sets on the page: it emits a fixed tag set, escapes raw
 * HTML, and neutralizes unsafe link targets.
 */
// Usage: const html = createParser('one-dark-pro', 'Copy', null).parse('**hi**', { async: false });
export function createParser(
  theme: CodeThemeId,
  copyCodeLabel: string,
  highlighter: CodeHighlighter | null
): Marked {
  return new Marked({
    ...MARKDOWN_SYNTAX_OPTIONS,
    renderer: createRenderer(theme, copyCodeLabel, highlighter),
  });
}

/** What the lexer needs to know; the renderer, theme and highlighter play no part in the tokens. */
const MARKDOWN_SYNTAX_OPTIONS = { gfm: true, breaks: true } as const;

/**
 * The options every chat lexer runs with: the same syntax as `createParser`, with no renderer.
 * One lexer feeds the language scan and every parser, because the tokens do not depend on how
 * they are rendered.
 */
// Usage: new IncrementalLexer(MARKDOWN_LEXER_OPTIONS)
export const MARKDOWN_LEXER_OPTIONS: MarkedOptions = new Marked(MARKDOWN_SYNTAX_OPTIONS).defaults;

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
  renderer.table = renderTable;
  return renderer;
}

/**
 * Seats a table in a box that scrolls sideways when its columns need more room
 * than the bubble has. Scrolling the `<table>` itself would mean
 * `display: block`, which shrink-wraps a narrow table and strips its table
 * semantics from some screen readers; a wrapper leaves the table a table.
 *
 * `this` is the renderer `marked` runs the call on, which carries the `parser`
 * the default `table` needs — a copy bound to the one built here would have
 * none. // Usage: renderer.table = renderTable
 */
function renderTable(this: Renderer, token: Parameters<Renderer['table']>[0]): string {
  return `<div class="markdown-table-scroll">${Renderer.prototype.table.call(this, token)}</div>`;
}

/**
 * Renders a link whose href *and* body are both inert.
 *
 * Child tokens are flattened to their source text and escaped: the result is
 * interpolated into the same HTML string as everything else, which is
 * written to the page as markup, so unescaped label text is live markup — `[x<img src=y onerror=…>](…)`
 * is a script-execution path that a safe href does nothing to close.
 * // Usage: renderLink({ href: 'https://a.example', tokens: [] })
 */
function renderLink({ href, title, tokens }: Parameters<Renderer['link']>[0]): string {
  const text =
    tokens
      ?.map((token): string =>
        escapeMarkdownText('text' in token ? (token.text as string) : token.raw)
      )
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

/** An `&` the source did not already spend on an entity of its own. */
const UNENCODED_AMPERSAND = /&(?!#?\w+;)/g;

/**
 * Escapes markup in text markdown handed over already-decoded, leaving an
 * entity the source wrote alone.
 *
 * The strict `escapeHtml` is right for a value MangoStudio built — an href, a
 * title, a code body. It is wrong for markdown's own text, which reaches the
 * renderer with its entities intact: re-escaping the `&` in `&amp;` renders
 * the entity rather than the character, so `[a &amp; b](…)` read `a &amp; b`
 * on screen while the same source outside a link read `a & b`. `<`, `>`, `"`
 * and `'` are still escaped unconditionally, so nothing here can open a tag;
 * a decoded entity is a text node either way.
 *
 * Usage: escapeMarkdownText('a &amp; <b>') === 'a &amp; &lt;b&gt;'
 */
function escapeMarkdownText(value: string): string {
  return value
    .replace(UNENCODED_AMPERSAND, '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
