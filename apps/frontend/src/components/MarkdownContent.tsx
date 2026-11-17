import { Suspense, useEffect } from 'react';

import { preloadCodeHighlighterFor } from '@/lib/code-highlighter-preload';
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
 * failing. The import is asked for again after a backoff, not on every mount, and
 * not at all once the hub is known to have been upgraded: the page-level notice
 * then carries the Reload.
 */
// Usage: <MarkdownContent content={message.text} />;
export function MarkdownContent(props: MarkdownContentProps) {
  const { content } = props;
  useEffect(() => preloadCodeHighlighterFor(content), [content]);
  return (
    <LazyChunkBoundary
      onRetry={markdownRenderer.reset}
      renderFailure={() => <MarkdownContentFallback {...props} failed />}
    >
      <Suspense fallback={<MarkdownContentFallback {...props} />}>
        <markdownRenderer.Component {...props} />
      </Suspense>
    </LazyChunkBoundary>
  );
}

/**
 * The text as written, until (or instead of) the rendered form. `pre-wrap` keeps
 * the line breaks and indentation of code and lists, so the fallback stays
 * readable and the swap to the rendered form does not reflow it much.
 */
function MarkdownContentFallback({
  content,
  className,
  failed = false,
}: MarkdownContentProps & { readonly failed?: boolean }) {
  return (
    <div
      className={`markdown-content whitespace-pre-wrap ${className ?? ''}`}
      data-markdown-fallback={failed ? 'failed' : 'loading'}
    >
      {content}
    </div>
  );
}
