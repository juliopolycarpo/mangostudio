import { treaty } from '@elysiajs/eden';
import type { App } from '@mangostudio/api';
import { getApiBaseUrl } from './api-base-url';

/** Debounced 401 redirect — prevents multiple simultaneous redirects from
 *  parallel queries and avoids redirecting when already on the login page. */
let redirectScheduled = false;

function handle401(): void {
  if (redirectScheduled) return;
  if (window.location.pathname === '/login' || window.location.pathname === '/signup') return;
  redirectScheduled = true;
  // Small delay so in-flight parallel requests don't each trigger a redirect
  setTimeout(() => {
    window.location.href = '/login';
  }, 100);
}

export const client = treaty<App>(getApiBaseUrl(), {
  fetcher: (async (url, init) => {
    const response = await fetch(url, { ...init, credentials: 'include' });

    if (response.status === 401) {
      handle401();
    }

    return response;
  }) as typeof fetch,
});
