import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';
import { LazyChunkLoadError } from '@/lib/retryable-lazy';
import { isRunningStaleBuild } from '@/lib/stale-build';

interface LazyChunkBoundaryProps {
  readonly children: ReactNode;
  /** Forgets the failed import (`RetryableLazy.reset`) before the children render again. */
  readonly onRetry: () => void;
  /**
   * Draws something in place of the failure panel, for content that has a
   * graceful form (markdown falls back to its plain text). The panel's Retry and
   * Reload do not appear then, so pair it with `onFailure`.
   */
  readonly renderFailure?: () => ReactNode;
  /** Called once when the chunk failed, e.g. to forget it so the next mount asks the network again. */
  readonly onFailure?: () => void;
  /** Whether the hub now serves a newer build than this tab. Replaceable in tests. */
  readonly probeStaleBuild?: () => Promise<boolean>;
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

  componentDidCatch(error: unknown): void {
    if (error instanceof LazyChunkLoadError) this.props.onFailure?.();
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
    if (this.props.renderFailure) return this.props.renderFailure();
    return (
      <LazyChunkFailure
        onRetry={this.retry}
        probeStaleBuild={this.props.probeStaleBuild ?? isRunningStaleBuild}
      />
    );
  }
}

interface LazyChunkFailureProps {
  readonly onRetry: () => void;
  readonly probeStaleBuild: () => Promise<boolean>;
}

/**
 * Two situations look alike from the failed import and need different advice:
 * a dropped connection (Retry can work) and a hub that was upgraded under this
 * tab (the hashed chunk name is gone, so only Reload can). The panel offers
 * both at first and, once the probe says the build is stale, only Reload.
 * It never reloads on its own.
 */
function LazyChunkFailure({ onRetry, probeStaleBuild }: LazyChunkFailureProps) {
  const { t } = useI18n();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let current = true;
    void probeStaleBuild().then((isStale) => {
      if (current) setStale(isStale);
    });
    return () => {
      current = false;
    };
  }, [probeStaleBuild]);

  return (
    <div role="alert" data-testid="lazy-chunk-failure" data-stale-build={stale} className="h-full">
      <EmptyState
        icon={<TriangleAlert aria-hidden size={ICON_LG} />}
        tone="warning"
        title={stale ? t.errors.lazyChunk.staleTitle : t.errors.lazyChunk.title}
        hint={stale ? t.errors.lazyChunk.staleHint : t.errors.lazyChunk.hint}
        className="h-full"
        action={
          <div className="flex gap-2">
            {stale ? null : (
              <Button size="sm" onClick={onRetry}>
                {t.common.retry}
              </Button>
            )}
            <Button
              size="sm"
              variant={stale ? 'primary' : 'secondary'}
              onClick={() => window.location.reload()}
            >
              {t.errors.lazyChunk.reload}
            </Button>
          </div>
        }
      />
    </div>
  );
}
