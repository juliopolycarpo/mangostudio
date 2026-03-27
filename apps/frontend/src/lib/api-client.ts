import { edenTreaty } from '@elysiajs/eden';
import type { App } from '@mangostudio/api';
import { getApiBaseUrl } from './api-base-url';

export const client = edenTreaty<App>(getApiBaseUrl(), {
  fetcher: (async (url, init) => {
    const response = await fetch(url, { ...init, credentials: 'include' });

    if (response.status === 401) {
      // Sessão expirou — redirecionar para login
      window.location.href = '/login';
    }

    return response;
  }) as typeof fetch,
});
