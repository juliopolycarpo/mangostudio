import { useMemo } from 'react';
import { Marked, Renderer } from 'marked';
import { highlightCode } from '@/lib/shiki';

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
    // Inject data-lang into Shiki's <pre> for the language badge
    return highlighted.replace('<pre ', `<pre data-lang="${safeLang}" `);
  }

  // Fallback: plain code block
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const langClass = safeLang ? ` class="language-${safeLang}"` : '';
  const langAttr = safeLang ? ` data-lang="${safeLang}"` : '';
  return `<pre${langAttr}><code${langClass}>${escaped}</code></pre>`;
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
}

export function MarkdownContent({ content, className, isStreaming }: MarkdownContentProps) {
  const html = useMemo(() => {
    if (!content) return '';
    return marked.parse(content, { async: false }) as string;
  }, [content]);

  const renderedHtml = isStreaming
    ? (marked.parse(content || '', { async: false }) as string)
    : html;

  return (
    <div
      className={`markdown-content ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
