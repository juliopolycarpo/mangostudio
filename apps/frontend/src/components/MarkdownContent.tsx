import { useEffect, useMemo, useRef } from 'react';
import { Marked, Renderer } from 'marked';
import { highlightCode } from '@/lib/shiki';

const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function copyButton(ariaLabel: string): string {
  return `<button class="copy-code-btn" type="button" aria-label="${ariaLabel}">${CLIPBOARD_ICON}</button>`;
}

const renderer = new Renderer();

renderer.link = ({ href, title, tokens }) => {
  const text = tokens?.map((t) => ('text' in t ? t.text : t.raw)).join('') ?? '';
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
  const highlighted = safeLang ? highlightCode(text, safeLang) : null;
  if (highlighted) {
    // Inject data-lang and copy button into Shiki's <pre>
    return highlighted
      .replace('<pre ', `<pre data-lang="${safeLang}" `)
      .replace('</pre>', `${copyButton('Copy code')}</pre>`);
  }

  // Fallback: plain code block
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const langClass = safeLang ? ` class="language-${safeLang}"` : '';
  const langAttr = safeLang ? ` data-lang="${safeLang}"` : '';
  return `<pre${langAttr}><code${langClass}>${escaped}</code>${copyButton('Copy code')}</pre>`;
};

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer,
});

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

  const html = useMemo(() => {
    if (!content) return '';
    return marked.parse(content, { async: false }) as string;
  }, [content]);

  const renderedHtml = isStreaming
    ? (marked.parse(content || '', { async: false }) as string)
    : html;

  // Event delegation for copy buttons — survives dangerouslySetInnerHTML re-renders
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('.copy-code-btn') as HTMLButtonElement | null;
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
        setTimeout(() => {
          btn.innerHTML = CLIPBOARD_ICON;
          btn.setAttribute('aria-label', copyCodeLabel);
          btn.classList.remove('copy-code-btn--copied');
        }, 2000);
      } catch {
        // Clipboard API not available — silently fail
      }
    };

    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, [copyCodeLabel, codeCopiedLabel]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
