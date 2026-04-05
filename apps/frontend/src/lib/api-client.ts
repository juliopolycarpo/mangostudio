import { edenTreaty } from '@elysiajs/eden';
import type { App } from '@mangostudio/api';
import { getApiBaseUrl } from './api-base-url';

export const client = edenTreaty<App>(getApiBaseUrl(), {
  fetcher: (async (url, init) => {
    const response = await fetch(url, { ...init, credentials: 'include' });

    if (response.status === 401) {
      // Only redirect when NOT already on an auth page to avoid infinite loops.
      const path = window.location.pathname;
      if (path !== '/login' && path !== '/signup') {
        window.location.href = '/login';
      }
    }

    return response;
  }) as typeof fetch,
});
