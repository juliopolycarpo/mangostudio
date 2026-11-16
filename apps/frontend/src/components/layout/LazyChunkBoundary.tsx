import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';
import { LazyChunkLoadError } from '@/lib/retryable-lazy';

interface LazyChunkBoundaryProps {
  readonly children: ReactNode;
  /** Forgets the failed import (`RetryableLazy.reset`) before the children render again. */
  readonly onRetry: () => void;
}

interface LazyChunkBoundaryState {
  readonly error: unknown;
}

const NO_ERROR: LazyChunkBoundaryState = { error: undefined };

/**
 * Keeps a lazy chunk that did not arrive local to the region that needed it.
 *
 * Without this, a rejected `import()` under `Suspense` reaches the route's
 * boundary and replaces the whole page. Inside the rail that would take the
 * chat down because the Git panel's script was unreachable. Here the region
 * says what failed and offers the two things that can help: ask again (the
 * network came back), or reload the page (the hub was upgraded under this tab,
 * so the hashed name it asks for no longer exists and asking again cannot work).
 *
 * Only `LazyChunkLoadError` is caught. Any other error is a bug in the panel
 * itself and is rethrown so the route boundary reports it as it always did.
 *
 * @example
 * <LazyChunkBoundary onRetry={GitPanel.reset}><Suspense fallback={…}><GitPanel.Component /></Suspense></LazyChunkBoundary>
 */
export class LazyChunkBoundary extends Component<LazyChunkBoundaryProps, LazyChunkBoundaryState> {
  state = NO_ERROR;

  static getDerivedStateFromError(error: unknown): LazyChunkBoundaryState {
    return { error };
  }

  private readonly retry = (): void => {
    this.props.onRetry();
    this.setState(NO_ERROR);
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    if (!(error instanceof LazyChunkLoadError)) {
      throw error instanceof Error
        ? error
        : new Error('A lazy panel threw a non-Error value.', { cause: error });
    }
    return <LazyChunkFailure onRetry={this.retry} />;
  }
}

function LazyChunkFailure({ onRetry }: { readonly onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" data-testid="lazy-chunk-failure" className="h-full">
      <EmptyState
        icon={<TriangleAlert aria-hidden size={ICON_LG} />}
        tone="warning"
        title={t.errors.lazyChunk.title}
        hint={t.errors.lazyChunk.hint}
        className="h-full"
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={onRetry}>
              {t.common.retry}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              {t.errors.lazyChunk.reload}
            </Button>
          </div>
        }
      />
    </div>
  );
}
