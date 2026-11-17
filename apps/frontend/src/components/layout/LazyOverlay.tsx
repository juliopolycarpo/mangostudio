import { type ReactNode, Suspense, useEffect } from 'react';

import { LazyChunkBoundary } from '@/components/layout/LazyChunkBoundary';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { type RetryableLazy, retryableLazy } from '@/lib/retryable-lazy';

/** What a lazy overlay takes on top of the overlay's own props. */
interface LazyOverlayExtraProps {
  /**
   * Called when the overlay's chunk could not be fetched. The overlay is gone
   * by then, so the owner must clear whatever state opened it: the person is
   * told with a toast and can click again.
   */
  readonly onLoadFailed: () => void;
}

export interface LazyOverlay<Props extends object> {
  /** Renders the overlay once its chunk arrives; renders nothing meanwhile. */
  readonly Overlay: (props: Props & LazyOverlayExtraProps) => ReactNode;
  /** Starts the import early, for a hover or focus on the control that opens the overlay. */
  readonly preload: RetryableLazy<Props>['preload'];
}

/**
 * Tells the person the overlay they asked for did not load, then closes it.
 * A dialog has no place to show the chunk failure panel, and a silent no-op
 * on click reads as a dead button.
 */
function OverlayLoadFailed({
  onDismiss,
  reset,
}: {
  readonly onDismiss: () => void;
  readonly reset: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  useEffect(() => {
    toast(t.errors.lazyChunk.title, 'error');
    // Forget the failed import so the next click asks the network again.
    reset();
    onDismiss();
    // Once per failure: the owner unmounts this on dismiss.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/**
 * A dialog, popover or picker that is only ever shown after an interaction,
 * kept out of the entry chunk. The owner keeps its `open` state and mounts
 * `Overlay` only while open, as it did with the eager component.
 *
 * Usage:
 * ```tsx
 * const sessionPicker = createLazyOverlay<PickerProps>(() =>
 *   import('./Picker').then((m) => ({ default: m.Picker })));
 * {open && <sessionPicker.Overlay {...pickerProps} onLoadFailed={() => setOpen(false)} />}
 * <Button onPointerEnter={sessionPicker.preload}>…</Button>
 * ```
 */
export function createLazyOverlay<Props extends object>(
  load: () => Promise<{ default: (props: Props) => ReactNode }>
): LazyOverlay<Props> {
  const binding = retryableLazy<Props>(load);
  function Overlay({ onLoadFailed, ...overlayProps }: Props & LazyOverlayExtraProps) {
    return (
      <LazyChunkBoundary
        onRetry={binding.reset}
        renderFailure={() => <OverlayLoadFailed onDismiss={onLoadFailed} reset={binding.reset} />}
      >
        <Suspense fallback={null}>
          <binding.Component {...(overlayProps as unknown as Props)} />
        </Suspense>
      </LazyChunkBoundary>
    );
  }
  return { Overlay, preload: binding.preload };
}
