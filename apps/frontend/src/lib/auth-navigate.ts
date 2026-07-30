type AuthNavigateHandler = () => void;

let handler: AuthNavigateHandler | null = null;

export function setAuthNavigate(fn: AuthNavigateHandler) {
  handler = fn;
}

export function navigateToLoginPage() {
  handler?.();
}

/** Debounced 401 redirect — prevents multiple simultaneous redirects from
 *  parallel queries and avoids redirecting when already on the login page. */
let redirectScheduled = false;

/**
 * Sends the user back to the auth flow after credentials stop working. Shared by
 * every rejected-session path (HTTP 401s and the realtime `4401` close code) so
 * they cannot each queue their own redirect.
 */
export function scheduleLoginRedirect(): void {
  if (redirectScheduled) return;
  if (window.location.pathname === '/login' || window.location.pathname === '/signup') return;
  redirectScheduled = true;
  // Small delay so in-flight parallel requests don't each trigger a redirect
  setTimeout(() => {
    navigateToLoginPage();
    // Re-arm for future sessions: SPA navigation never reloads the page, so the
    // module-level flag would otherwise stay true and suppress every later 401.
    redirectScheduled = false;
  }, 100);
}
