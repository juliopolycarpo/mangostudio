import { TriangleAlert } from 'lucide-react';
import { Component, createRef, type ReactNode, useEffect, useRef } from 'react';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { useBuildIsStale } from '@/hooks/use-stale-build';
import { ICON_LG } from '@/lib/icon-sizes';
import { LazyChunkLoadError } from '@/lib/retryable-lazy';
import { type StaleBuildMonitor, staleBuildMonitor } from '@/lib/stale-build';

import { STALE_BUILD_RELOAD_ID } from './StaleBuildNotice';

interface LazyChunkBoundaryProps {
  readonly children: ReactNode;
  /** Forgets the failed import (`RetryableLazy.reset`) before the children render again. */
  readonly onRetry: () => void;
  /**
   * Draws something in place of the failure panel, for content that has a
   * graceful form (markdown falls back to its plain text). The panel's Retry and
   * Reload do not appear then; a stale build still reaches the page-level notice.
   */
  readonly renderFailure?: () => ReactNode;
  /** Whether the hub now serves a newer build than this tab. Replaceable in tests. */
  readonly monitor?: StaleBuildMonitor;
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
    // Learn once, for the whole page, whether this is a hub upgrade. The probe is
    // shared, so many failing surfaces cost one request.
    if (error instanceof LazyChunkLoadError) void (this.props.monitor ?? staleBuildMonitor).check();
  }

  private readonly regionRef = createRef<HTMLDivElement>();
  /** Set by Retry: the button that had focus is about to unmount, so focus has to move. */
  private focusRegionOnRecovery = false;

  private readonly retry = (): void => {
    this.focusRegionOnRecovery = true;
    this.props.onRetry();
    this.setState(NO_ERROR);
  };

  componentDidUpdate(
    _previousProps: LazyChunkBoundaryProps,
    previousState: LazyChunkBoundaryState
  ) {
    // Without this, focus falls to <body> when the Retry button goes away and a
    // keyboard user has to tab in from the top of the page again.
    if (this.focusRegionOnRecovery && previousState.error !== undefined) {
      this.focusRegionOnRecovery = false;
      this.regionRef.current?.focus({ preventScroll: true });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) {
      return (
        <div
          ref={this.regionRef}
          tabIndex={-1}
          data-testid="lazy-chunk-region"
          className="h-full outline-none"
        >
          {this.props.children}
        </div>
      );
    }
    if (!(error instanceof LazyChunkLoadError)) {
      throw error instanceof Error
        ? error
        : new Error('A lazy panel threw a non-Error value.', { cause: error });
    }
    if (this.props.renderFailure) return this.props.renderFailure();
    return (
      <LazyChunkFailure onRetry={this.retry} monitor={this.props.monitor ?? staleBuildMonitor} />
    );
  }
}

interface LazyChunkFailureProps {
  readonly onRetry: () => void;
  readonly monitor: StaleBuildMonitor;
}

/**
 * Two situations look alike from the failed import and need different advice:
 * a dropped connection (Retry can work) and a hub that was upgraded under this
 * tab (the hashed chunk name is gone, so only a reload can). Until the probe
 * says the build is stale the panel offers Retry and Reload; once it does, the
 * panel only says so and the page-level notice carries the single Reload, so
 * several failing surfaces do not each ask for one. It never reloads on its own.
 */
function LazyChunkFailure({ onRetry, monitor }: LazyChunkFailureProps) {
  const { t } = useI18n();
  const stale = useBuildIsStale(monitor);
  const sawStale = useRef(false);

  useEffect(() => {
    // Retry may have had focus when the probe removed it; hand focus to the notice's Reload.
    if (stale && !sawStale.current && !document.activeElement?.closest('[role="dialog"]')) {
      const lostFocus = document.activeElement === document.body || document.activeElement === null;
      if (lostFocus) document.getElementById(STALE_BUILD_RELOAD_ID)?.focus();
    }
    sawStale.current = stale;
  }, [stale]);

  return (
    <div role="alert" data-testid="lazy-chunk-failure" data-stale-build={stale} className="h-full">
      <EmptyState
        icon={<TriangleAlert aria-hidden size={ICON_LG} />}
        tone="warning"
        title={stale ? t.errors.lazyChunk.staleTitle : t.errors.lazyChunk.title}
        hint={stale ? t.errors.lazyChunk.staleHint : t.errors.lazyChunk.hint}
        className="h-full"
        action={
          stale ? undefined : (
            <div className="flex gap-2">
              <Button size="sm" onClick={onRetry}>
                {t.common.retry}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
                {t.errors.lazyChunk.reload}
              </Button>
            </div>
          )
        }
      />
    </div>
  );
}
