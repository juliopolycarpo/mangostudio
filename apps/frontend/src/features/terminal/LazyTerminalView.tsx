import { Suspense } from 'react';

import { LazyChunkBoundary } from '@/components/layout/LazyChunkBoundary';
import { retryableLazy } from '@/lib/retryable-lazy';

import type { TerminalViewProps } from './TerminalView';

const terminalView = retryableLazy<TerminalViewProps>(() =>
  import('./TerminalView').then((module) => ({ default: module.TerminalView }))
);

/**
 * `TerminalView` behind one shared lazy binding.
 *
 * Xterm and its addons (~300 KB with CSS) load only once a session is actually
 * shown, not with every chat page's first paint. Declared once so the rail panel
 * and the `/terminal` page reference the same chunk rather than each wrapping
 * their own import.
 *
 * The boundary lives here so a chunk that cannot be fetched says so where the
 * terminal would be, with Retry and Reload, instead of replacing the page.
 *
 * @example
 * <LazyTerminalView sessionId={id} />
 */
export function LazyTerminalView(props: TerminalViewProps) {
  return (
    <LazyChunkBoundary onRetry={terminalView.reset}>
      <Suspense fallback={null}>
        <terminalView.Component {...props} />
      </Suspense>
    </LazyChunkBoundary>
  );
}
