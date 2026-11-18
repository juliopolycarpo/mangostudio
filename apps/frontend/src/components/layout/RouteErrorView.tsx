/**
 * The router's default error boundary: what a route shows when it fails to load
 * or render and has no `errorComponent` of its own.
 *
 * Route components are dynamic imports, so a route can now fail for a reason no
 * code change fixes: the chunk did not arrive (the connection dropped, or the
 * hub was upgraded under this tab and the hashed name is gone). TanStack's
 * default replaces the page with an unstyled "Something went wrong!" box that
 * offers no way forward but a manual page reload. A chunk-load failure gets the
 * same Retry and Reload panel a failed lazy panel shows; any other error is a
 * bug in the route and keeps the router's own generic view.
 *
 * Routes that declare their own `errorComponent` (the authenticated gate and
 * welcome, via `BootstrapErrorPanel`) are unaffected.
 */

import { ErrorComponent, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { isChunkFetchFailure, LazyChunkLoadError } from '@/lib/retryable-lazy';
import { staleBuildMonitor } from '@/lib/stale-build';

import { LazyChunkFailure } from './LazyChunkBoundary';

/** True when `error` means a route's code could not be fetched, as opposed to the route throwing. */
function isRouteChunkFailure(error: unknown): boolean {
  return error instanceof LazyChunkLoadError || isChunkFetchFailure(error);
}

/**
 * Registered as the router's `defaultErrorComponent`.
 *
 * @example
 * createRouter({ routeTree, defaultErrorComponent: RouteErrorView });
 */
export function RouteErrorView({ error }: { readonly error: unknown }) {
  return isRouteChunkFailure(error) ? <RouteChunkFailure /> : <ErrorComponent error={error} />;
}

function RouteChunkFailure() {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  // Learn once, for the whole page, whether this is a hub upgrade; the probe is
  // shared, so several failing surfaces cost one request and one reload notice.
  useEffect(() => {
    void staleBuildMonitor.check();
  }, []);

  return (
    <div className="flex h-full min-h-64 items-center justify-center px-4">
      <LazyChunkFailure
        retrying={retrying}
        monitor={staleBuildMonitor}
        // Invalidating re-runs the match, and the router forgets a failed route
        // import on its own, so this asks the network again rather than
        // replaying the first failure.
        onRetry={() => {
          setRetrying(true);
          void router.invalidate().finally(() => setRetrying(false));
        }}
      />
    </div>
  );
}
