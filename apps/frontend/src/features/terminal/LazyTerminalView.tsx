import { lazy } from 'react';

/**
 * `TerminalView` behind one shared `lazy()` binding.
 *
 * Xterm and its addons (~300 KB with CSS) load only once a session is actually
 * shown, not with every chat page's first paint. Declared once so the rail panel
 * and the `/terminal` page reference the same chunk rather than each wrapping
 * their own import.
 *
 * @example
 * <Suspense fallback={null}><LazyTerminalView sessionId={id} /></Suspense>
 */
export const LazyTerminalView = lazy(() =>
  import('./TerminalView').then((module) => ({ default: module.TerminalView }))
);
