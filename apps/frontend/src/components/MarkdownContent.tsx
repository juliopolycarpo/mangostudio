import { lazy, Suspense } from 'react';
import type { MarkdownContentProps } from './MarkdownContentRenderer';

const LazyMarkdownContentRenderer = lazy(() =>
  import('./MarkdownContentRenderer').then((module) => ({
    default: module.MarkdownContentRenderer,
  }))
);

/** Lazy-loads markdown parsing so chat routes do not pull it into startup JS. */
// Usage: <MarkdownContent content={message.text} />;
export function MarkdownContent(props: MarkdownContentProps) {
  return (
    <Suspense fallback={<MarkdownContentFallback {...props} />}>
      <LazyMarkdownContentRenderer {...props} />
    </Suspense>
  );
}

function MarkdownContentFallback({ content, className }: MarkdownContentProps) {
  return <div className={`markdown-content ${className ?? ''}`}>{content}</div>;
}
