import { Suspense } from 'react';

import { retryableLazy } from '@/lib/retryable-lazy';

import { LazyChunkBoundary } from './layout/LazyChunkBoundary';
import type { MarkdownContentProps } from './MarkdownContentRenderer';

const markdownRenderer = retryableLazy<MarkdownContentProps>(() =>
  import('./MarkdownContentRenderer').then((module) => ({
    default: module.MarkdownContentRenderer,
  }))
);

/**
 * Lazy-loads markdown parsing so chat routes do not pull it into startup JS.
 *
 * If the renderer chunk cannot be fetched, the text stays on screen unformatted
 * (the same plain text the loading state shows) rather than the transcript
 * failing, and the next mount asks the network again.
 */
// Usage: <MarkdownContent content={message.text} />;
export function MarkdownContent(props: MarkdownContentProps) {
  return (
    <LazyChunkBoundary
      onRetry={markdownRenderer.reset}
      onFailure={markdownRenderer.reset}
      renderFailure={() => <MarkdownContentFallback {...props} />}
    >
      <Suspense fallback={<MarkdownContentFallback {...props} />}>
        <markdownRenderer.Component {...props} />
      </Suspense>
    </LazyChunkBoundary>
  );
}

function MarkdownContentFallback({ content, className }: MarkdownContentProps) {
  return <div className={`markdown-content ${className ?? ''}`}>{content}</div>;
}
