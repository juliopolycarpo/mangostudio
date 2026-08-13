import { treaty } from '@elysia/eden';
import type { App } from '@mangostudio/api';
import { getApiBaseUrl } from './api-base-url';
import { scheduleLoginRedirect } from './auth-navigate';

export const client = treaty<App>(getApiBaseUrl(), {
  fetcher: (async (url, init) => {
    const response = await fetch(url, { ...init, credentials: 'include' });

    if (response.status === 401) {
      scheduleLoginRedirect();
    }

    return response;
  }) as typeof fetch,
});
