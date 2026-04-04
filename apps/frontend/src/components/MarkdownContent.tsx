import { useMemo } from 'react';
import { Marked, Renderer } from 'marked';

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
