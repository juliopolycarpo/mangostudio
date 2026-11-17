import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode, type RefObject, startTransition, useRef } from 'react';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';
import { LazyChunkLoadError } from '@/lib/retryable-lazy';

interface LazyChunkBoundaryProps {
  readonly children: ReactNode;
  /** Forgets the failed import (`RetryableLazy.reset`) before the children render again. */
  readonly onRetry: () => void;
}

interface ChunkErrorBoundaryProps extends LazyChunkBoundaryProps {
  /** The region around the boundary: it stays mounted when the boundary swaps its children for the failure. */
  readonly regionRef: RefObject<HTMLDivElement | null>;
}

interface LazyChunkBoundaryState {
  readonly error: unknown;
  /** A Retry is waiting on the chunk; the failure stays up, with a spinner, meanwhile. */
  readonly retrying: boolean;
}

const NO_ERROR: LazyChunkBoundaryState = { error: undefined, retrying: false };

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
 * The region is a `tabIndex={-1}` wrapper outside the error boundary proper:
 * React throws away a boundary's own children when it catches, so a wrapper
 * inside would be rebuilt and take the focus with it.
 *
 * @example
 * <LazyChunkBoundary onRetry={GitPanel.reset}><Suspense fallback={…}><GitPanel.Component /></Suspense></LazyChunkBoundary>
 */
export function LazyChunkBoundary({ children, onRetry }: LazyChunkBoundaryProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={regionRef}
      tabIndex={-1}
      data-testid="lazy-chunk-region"
      className="h-full outline-none"
    >
      <ChunkErrorBoundary regionRef={regionRef} onRetry={onRetry}>
        {children}
      </ChunkErrorBoundary>
    </div>
  );
}

class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, LazyChunkBoundaryState> {
  state = NO_ERROR;

  static getDerivedStateFromError(error: unknown): LazyChunkBoundaryState {
    return { error, retrying: false };
  }

  private readonly retry = (): void => {
    // Focus moves to the region, which stays mounted whether the chunk arrives
    // or fails again. The Retry button does not stay: it is replaced either way.
    this.props.regionRef.current?.focus({ preventScroll: true });
    this.props.onRetry();
    this.setState({ retrying: true });
    // A transition, so a Suspense boundary that sits outside this one (the
    // rail's) keeps the failure on screen while the chunk loads, instead of
    // hiding the region, and the focus in it, behind its fallback.
    startTransition(() => this.setState(NO_ERROR));
  };

  render(): ReactNode {
    const { error, retrying } = this.state;
    if (error !== undefined && !(error instanceof LazyChunkLoadError)) {
      throw error instanceof Error
        ? error
        : new Error('A lazy panel threw a non-Error value.', { cause: error });
    }
    return error === undefined ? (
      this.props.children
    ) : (
      <LazyChunkFailure retrying={retrying} onRetry={this.retry} />
    );
  }
}

function LazyChunkFailure({
  retrying,
  onRetry,
}: {
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div role="alert" aria-busy={retrying} data-testid="lazy-chunk-failure" className="h-full">
      <EmptyState
        icon={<TriangleAlert aria-hidden size={ICON_LG} />}
        tone="warning"
        title={t.errors.lazyChunk.title}
        hint={t.errors.lazyChunk.hint}
        className="h-full"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onRetry}>
              {t.common.retry}
            </Button>
            {retrying ? <Spinner size="sm" label={t.common.loading} /> : null}
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              {t.errors.lazyChunk.reload}
            </Button>
          </div>
        }
      />
    </div>
  );
}
