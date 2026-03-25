import { edenTreaty } from '@elysiajs/eden';
import type { App } from '@mangostudio/api';
import type { Elysia } from 'elysia';

const url = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export const client = edenTreaty<App>(url, {
  fetcher: async (url, init) => {
    const response = await fetch(url, { ...init, credentials: 'include' });

    if (response.status === 401) {
      // Sessão expirou — redirecionar para login
      window.location.href = '/login';
    }

    return response;
  },
});
