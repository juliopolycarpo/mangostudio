import { useEffect, useMemo, useRef } from 'react';
import { Marked, Renderer } from 'marked';
import { highlightCode, type CodeThemeId } from '@/lib/shiki';
import { useTheme } from '@/hooks/use-theme';

const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function copyButton(ariaLabel: string): string {
  return `<button class="copy-code-btn" type="button" aria-label="${ariaLabel}">${CLIPBOARD_ICON}</button>`;
}

function createRenderer(theme: CodeThemeId): Renderer {
  const renderer = new Renderer();

  renderer.link = ({ href, title, tokens }) => {
    const text =
      tokens?.map((t): string => ('text' in t ? (t.text as string) : t.raw)).join('') ?? '';
    const safeHref = href?.startsWith('javascript:') ? '#' : href;
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img src="${href}" alt="${text}"${titleAttr} loading="lazy" />`;
  };

  renderer.code = ({ text, lang }) => {
    const safeLang = lang ?? '';
    const highlighted = safeLang ? highlightCode(text, safeLang, theme) : null;
    if (highlighted) {
      return highlighted
        .replace('<pre ', `<pre data-lang="${safeLang}" `)
        .replace('</pre>', `${copyButton('Copy code')}</pre>`);
    }

    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langClass = safeLang ? ` class="language-${safeLang}"` : '';
    const langAttr = safeLang ? ` data-lang="${safeLang}"` : '';
    return `<pre${langAttr}><code${langClass}>${escaped}</code>${copyButton('Copy code')}</pre>`;
  };

  return renderer;
}

function createParser(theme: CodeThemeId): Marked {
  return new Marked({ gfm: true, breaks: true, renderer: createRenderer(theme) });
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
  copyCodeLabel = 'Copy code',
  codeCopiedLabel = 'Copied!',
}: MarkdownContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedCodeTheme } = useTheme();

  const parser = useMemo(() => createParser(resolvedCodeTheme), [resolvedCodeTheme]);

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
          btn.setAttribute('aria-label', codeCopiedLabel);
          btn.classList.add('copy-code-btn--copied');
          // Timer is tracked in pendingResetTimers and cleared on unmount
          // (see effect cleanup below), the rule cannot trace through the
          // async click callback.
          // eslint-disable-next-line @eslint-react/web-api-no-leaked-timeout
          const resetTimer = setTimeout(() => {
            pendingResetTimers.delete(resetTimer);
            btn.innerHTML = CLIPBOARD_ICON;
            btn.setAttribute('aria-label', copyCodeLabel);
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
  }, [copyCodeLabel, codeCopiedLabel]);

  // Image lightbox — click to zoom inline markdown images
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let activeClose: (() => void) | null = null;

    const handleImageClick = (e: MouseEvent) => {
      const img = e.target as HTMLElement;
      if (img.tagName !== 'IMG') return;

      // Don't intercept images inside links
      if (img.closest('a')) return;

      const src = img.getAttribute('src');
      if (!src) return;

      const overlay = document.createElement('div');
      overlay.className = 'markdown-lightbox';
      overlay.innerHTML = `<img src="${src}" alt="${img.getAttribute('alt') ?? ''}" />`;

      const handleAnimationEnd = () => overlay.remove();
      const handleKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') close();
      };
      const handleOverlayClick = (): void => close();
      function close(): void {
        overlay.classList.add('markdown-lightbox--closing');
        // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener
        overlay.addEventListener('animationend', handleAnimationEnd, { once: true });
        overlay.removeEventListener('click', handleOverlayClick);
        document.removeEventListener('keydown', handleKey);
        if (activeClose === close) activeClose = null;
      }

      activeClose = close;
      // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener
      overlay.addEventListener('click', handleOverlayClick);
      // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener
      document.addEventListener('keydown', handleKey);

      document.body.appendChild(overlay);
    };

    container.addEventListener('click', handleImageClick);
    return () => {
      container.removeEventListener('click', handleImageClick);
      // Close any open lightbox when the component unmounts to prevent
      // dangling document-level listeners.
      activeClose?.();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`markdown-content ${className ?? ''}`}
      // HTML is produced by `marked` with a custom renderer that only emits
      // a fixed tag set and escapes user input; rendering as HTML is required
      // to surface Shiki-highlighted code blocks and link/image elements.
      // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
