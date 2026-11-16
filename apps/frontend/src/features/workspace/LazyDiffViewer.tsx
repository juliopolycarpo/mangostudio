import { Suspense } from 'react';

import { LazyChunkBoundary } from '@/components/layout/LazyChunkBoundary';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { retryableLazy } from '@/lib/retryable-lazy';

import type { DiffSelection } from './DiffViewer';

interface LazyDiffViewerProps {
  readonly chatId: string;
  readonly selection: DiffSelection;
  readonly onClose: () => void;
}

const diffViewer = retryableLazy<LazyDiffViewerProps>(() =>
  import('./DiffViewer').then((module) => ({ default: module.DiffViewer }))
);

/**
 * Loads the diff viewer on the first opened diff, mirroring `MarkdownContent`:
 * the viewer statically pulls the shiki engine, and every chat would otherwise
 * pay for it at startup whether or not a diff is ever opened.
 *
 * The boundary lives here rather than at each call site so the panel keeps one
 * lazy binding, one fallback and one failure state (Retry and Reload) instead of
 * a copy per place a diff can open.
 *
 * @example
 * <LazyDiffViewer chatId={chatId} selection={diffSelection} onClose={close} />
 */
export function LazyDiffViewer(props: LazyDiffViewerProps) {
  return (
    <LazyChunkBoundary onRetry={diffViewer.reset}>
      <Suspense fallback={<DiffViewerFallback />}>
        <diffViewer.Component {...props} />
      </Suspense>
    </LazyChunkBoundary>
  );
}

// Mirrors DiffViewer's own `query.isLoading` message so the chunk fetch and the
// diff fetch read as one continuous load instead of a blank flash then a spinner.
function DiffViewerFallback() {
  const { t } = useI18n();

  return <EmptyState icon={<Spinner />} title={t.git.diff.loading} className="min-h-32" />;
}
