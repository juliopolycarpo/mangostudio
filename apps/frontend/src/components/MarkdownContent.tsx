import { Marked, Renderer } from 'marked';
import { useEffect, useMemo, useRef } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import { type CodeThemeId, highlightCode } from '@/lib/shiki';

const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function copyButton(ariaLabel: string): string {
  // Escape: the label is now i18n/prop-driven, not a hardcoded literal, so it
  // must not be able to break out of the aria-label attribute.
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

function createRenderer(theme: CodeThemeId, copyCodeLabel: string): Renderer {
  const renderer = new Renderer();

  renderer.link = ({ href, title, tokens }) => {
    const text =
      tokens?.map((t): string => ('text' in t ? (t.text as string) : t.raw)).join('') ?? '';
    const safeHref = href?.startsWith('javascript:') ? '#' : (href ?? '#');
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const safeHref = href?.startsWith('javascript:') ? '#' : (href ?? '#');
    const titleAttr = title ? ` title="${title}"` : '';
    // Structured `generated_image` parts are the supported image path in chat.
    // Rendering arbitrary markdown images as real <img> tags lets external or
    // hallucinated URLs thrash the virtualized feed while they resolve/fail.
    // Keep the reference visible, but render it as a stable link instead.
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="markdown-image-link"${titleAttr}>${text || safeHref}</a>`;
  };

  renderer.html = (token) => escapeHtml('text' in token ? token.text : '');

  renderer.code = ({ text, lang }) => {
    const safeLang = lang ?? '';
    const highlighted = safeLang ? highlightCode(text, safeLang, theme) : null;
    if (highlighted) {
      return highlighted
        .replace('<pre ', `<pre data-lang="${safeLang}" `)
        .replace('</pre>', `${copyButton(copyCodeLabel)}</pre>`);
    }

    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langClass = safeLang ? ` class="language-${safeLang}"` : '';
    const langAttr = safeLang ? ` data-lang="${safeLang}"` : '';
    return `<pre${langAttr}><code${langClass}>${escaped}</code>${copyButton(copyCodeLabel)}</pre>`;
  };

  return renderer;
}

function createParser(theme: CodeThemeId, copyCodeLabel: string): Marked {
  return new Marked({ gfm: true, breaks: true, renderer: createRenderer(theme, copyCodeLabel) });
}

interface MarkdownContentProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  copyCodeLabel?: string;
  codeCopiedLabel?: string;
}

export function MarkdownContent({
  content,
  className,
  isStreaming,
  copyCodeLabel,
  codeCopiedLabel,
}: MarkdownContentProps) {
  const { t } = useI18n();
  const resolvedCopyCodeLabel = copyCodeLabel ?? t.chat.copyCode;
  const resolvedCodeCopiedLabel = codeCopiedLabel ?? t.chat.codeCopied;
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedCodeTheme } = useTheme();

  const parser = useMemo(
    () => createParser(resolvedCodeTheme, resolvedCopyCodeLabel),
    [resolvedCodeTheme, resolvedCopyCodeLabel]
  );

  const html = useMemo(() => {
    if (!content) return '';
    return parser.parse(content, { async: false });
  }, [content, parser]);

  const renderedHtml = isStreaming ? parser.parse(content || '', { async: false }) : html;

  // Event delegation for copy buttons — survives dangerouslySetInnerHTML re-renders
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pendingResetTimers = new Set<ReturnType<typeof setTimeout>>();

    const handleClick = (e: MouseEvent) => {
      void (async () => {
        const btn = (e.target as HTMLElement).closest('.copy-code-btn');
        if (!btn) return;

        const pre = btn.closest('pre');
        if (!pre) return;

        const code = pre.querySelector('code');
        const text = code?.textContent ?? pre.textContent ?? '';
        try {
          await navigator.clipboard.writeText(text);
          btn.innerHTML = CHECK_ICON;
          btn.setAttribute('aria-label', resolvedCodeCopiedLabel);
          btn.classList.add('copy-code-btn--copied');
          // Timer is tracked in pendingResetTimers and cleared on unmount
          // (see effect cleanup below), the rule cannot trace through the
          // async click callback.
          // eslint-disable-next-line @eslint-react/web-api-no-leaked-timeout
          const resetTimer = setTimeout(() => {
            pendingResetTimers.delete(resetTimer);
            btn.innerHTML = CLIPBOARD_ICON;
            btn.setAttribute('aria-label', resolvedCopyCodeLabel);
            btn.classList.remove('copy-code-btn--copied');
          }, 2000);
          pendingResetTimers.add(resetTimer);
        } catch {
          // Clipboard API not available — silently fail
        }
      })();
    };

    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
      for (const timer of pendingResetTimers) clearTimeout(timer);
      pendingResetTimers.clear();
    };
  }, [resolvedCopyCodeLabel, resolvedCodeCopiedLabel]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content ${className ?? ''}`}
      // HTML is produced by `marked` with a custom renderer that only emits
      // a fixed tag set and escapes raw HTML; rendering as HTML is required
      // to surface Shiki-highlighted code blocks and safe link elements.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized markdown is rendered as HTML here
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
