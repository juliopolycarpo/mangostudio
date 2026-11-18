import { TriangleAlert } from 'lucide-react';
import {
  Component,
  type ReactNode,
  type RefObject,
  startTransition,
  useEffect,
  useRef,
} from 'react';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
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

interface ChunkErrorBoundaryProps extends LazyChunkBoundaryProps {
  /** The region around the boundary, when it has one: it stays mounted when the boundary swaps its children for the failure. */
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
 * With the failure panel the region is a `tabIndex={-1}` wrapper outside the
 * error boundary proper: React throws away a boundary's own children when it
 * catches, so a wrapper inside would be rebuilt and take the focus with it.
 * A boundary with `renderFailure` has no Retry to keep focus for, and adds no
 * wrapper, so text it surrounds (a message) does not become focusable.
 *
 * @example
 * <LazyChunkBoundary onRetry={GitPanel.reset}><Suspense fallback={…}><GitPanel.Component /></Suspense></LazyChunkBoundary>
 */
export function LazyChunkBoundary(props: LazyChunkBoundaryProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const boundary = <ChunkErrorBoundary {...props} regionRef={regionRef} />;
  if (props.renderFailure) return boundary;
  return (
    <div
      ref={regionRef}
      tabIndex={-1}
      data-testid="lazy-chunk-region"
      className="h-full outline-none"
    >
      {boundary}
    </div>
  );
}

class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, LazyChunkBoundaryState> {
  state = NO_ERROR;

  static getDerivedStateFromError(error: unknown): LazyChunkBoundaryState {
    return { error, retrying: false };
  }

  componentDidCatch(error: unknown): void {
    // Learn once, for the whole page, whether this is a hub upgrade. The probe is
    // shared, so many failing surfaces cost one request.
    if (error instanceof LazyChunkLoadError) void (this.props.monitor ?? staleBuildMonitor).check();
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
    if (error === undefined) return this.props.children;
    if (!(error instanceof LazyChunkLoadError)) {
      throw error instanceof Error
        ? error
        : new Error('A lazy panel threw a non-Error value.', { cause: error });
    }
    if (this.props.renderFailure) return this.props.renderFailure();
    return (
      <LazyChunkFailure
        retrying={retrying}
        onRetry={this.retry}
        monitor={this.props.monitor ?? staleBuildMonitor}
      />
    );
  }
}

export interface LazyChunkFailureProps {
  readonly retrying: boolean;
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
 *
 * Also the route boundary's failure view (`RouteErrorView`), so a failed route
 * chunk offers the same two actions as a failed panel.
 */
export function LazyChunkFailure({ retrying, onRetry, monitor }: LazyChunkFailureProps) {
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
    <div
      role="alert"
      aria-busy={retrying}
      data-testid="lazy-chunk-failure"
      data-stale-build={stale}
      className="h-full"
    >
      <EmptyState
        icon={<TriangleAlert aria-hidden size={ICON_LG} />}
        tone="warning"
        title={stale ? t.errors.lazyChunk.staleTitle : t.errors.lazyChunk.title}
        hint={stale ? t.errors.lazyChunk.staleHint : t.errors.lazyChunk.hint}
        className="h-full"
        action={
          stale ? undefined : (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={onRetry}>
                {t.common.retry}
              </Button>
              {retrying ? <Spinner size="sm" label={t.common.loading} /> : null}
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
