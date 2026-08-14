import { treaty } from '@elysia/eden';
import type { App } from '@mangostudio/api';
import { PROBLEM_JSON_ACCEPT } from '@mangostudio/shared/errors';
import { getApiBaseUrl } from './api-base-url';
import { scheduleLoginRedirect } from './auth-navigate';

export const client = treaty<App>(getApiBaseUrl(), {
  fetcher: (async (url, init) => {
    // Opt into RFC 9457 problem details for failures. Only error bodies are
    // negotiated, so successful responses are byte-identical to before; every
    // failed one is read through `normalizeApiErrorBody`, which handles either
    // representation. Eden sends no `Accept` of its own, and a caller that set
    // one meant it.
    const headers = new Headers(init?.headers);
    if (!headers.has('accept')) headers.set('accept', PROBLEM_JSON_ACCEPT);

    const response = await fetch(url, { ...init, headers, credentials: 'include' });

    // Keyed on the status, never on the body: an unauthenticated request has to
    // reach the login page whatever shape the server used to say so.
    if (response.status === 401) {
      scheduleLoginRedirect();
    }

    return response;
  }) as typeof fetch,
});
