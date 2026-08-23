/**
 * What the active frontend answers an otherwise-unmatched request with.
 *
 * Elysia runs `NotFound` handlers in registration order and only moves to the
 * next one when a handler returns nothing. `registerFrontend` runs against an
 * app that is already fully composed — the global API error plugin included —
 * so a handler registered from there is never reached on the real server.
 *
 * Keeping the decision here lets `app.ts` seat one handler ahead of the API
 * error plugin while `frontend-static.ts` still owns what that handler decides,
 * and keeps the two files free of an import cycle.
 */

/**
 * Returns the response the frontend claims, or `undefined` to defer.
 *
 * Synchronous on purpose: Elysia decides whether to try the next `NotFound`
 * handler from what this returns, and a promise is always something — so a
 * fallback that resolved to `undefined` would silently stop the chain. Both
 * branches answer from state they hold synchronously (embedded manifest +
 * boot-time validators, or a `statSync` result), so nothing needs to be async.
 */
export type FrontendFallback = (request: Request) => Response | undefined;

let activeFallback: FrontendFallback | null = null;

/** Install the fallback for the frontend mode that was detected at startup. */
export function setFrontendFallback(fallback: FrontendFallback): void {
  activeFallback = fallback;
}

/** Drop the installed fallback. Used by tests that compose apps in isolation. */
export function clearFrontendFallback(): void {
  activeFallback = null;
}

/** The active frontend's answer for an unmatched request, if it claims one. */
export function frontendNotFound(request: Request): Response | undefined {
  return activeFallback?.(request);
}
