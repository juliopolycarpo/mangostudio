import { lazy, Suspense, useEffect } from 'react';

import { preloadCodeHighlighterFor } from '@/lib/code-highlighter-preload';

import type { MarkdownContentProps } from './MarkdownContentRenderer';

const LazyMarkdownContentRenderer = lazy(() =>
  import('./MarkdownContentRenderer').then((module) => ({
    default: module.MarkdownContentRenderer,
  }))
);

/** Lazy-loads markdown parsing so chat routes do not pull it into startup JS. */
// Usage: <MarkdownContent content={message.text} />;
export function MarkdownContent(props: MarkdownContentProps) {
  const { content } = props;
  useEffect(() => preloadCodeHighlighterFor(content), [content]);
  return (
    <Suspense fallback={<MarkdownContentFallback {...props} />}>
      <LazyMarkdownContentRenderer {...props} />
    </Suspense>
  );
}

function MarkdownContentFallback({ content, className }: MarkdownContentProps) {
  return <div className={`markdown-content ${className ?? ''}`}>{content}</div>;
}
