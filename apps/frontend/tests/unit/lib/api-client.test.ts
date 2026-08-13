import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('api-client 401 handling', () => {
  let capturedFetcher: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
  let scheduleLoginRedirectMock = vi.fn();

  beforeEach(() => {
    capturedFetcher = null;
    scheduleLoginRedirectMock = vi.fn();
    vi.resetModules();

    vi.doMock('@elysiajs/eden', () => ({
      treaty: vi.fn((_baseUrl: string, options: { fetcher?: typeof fetch }) => {
        capturedFetcher = options.fetcher ?? null;
        return {};
      }),
    }));

    vi.doMock('../../../src/lib/auth-navigate', () => ({
      scheduleLoginRedirect: scheduleLoginRedirectMock,
    }));
  });

  function getFetcher(): (url: string, init?: RequestInit) => Promise<Response> {
    if (!capturedFetcher) {
      throw new Error('Fetcher was not captured from treaty mock');
    }
    return capturedFetcher;
  }

  it('schedules the login redirect on 401', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;

    await import('../../../src/lib/api-client');
    expect(capturedFetcher).toBeTruthy();

    const fetcher = getFetcher();
    await fetcher('/api/test', {});

    expect(scheduleLoginRedirectMock).toHaveBeenCalledOnce();
  });

  it('returns the response for non-401 statuses', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 })) as unknown as typeof fetch;

    await import('../../../src/lib/api-client');
    const fetcher = getFetcher();

    const result = await fetcher('/api/test', {});
    expect(result.status).toBe(200);
    expect(scheduleLoginRedirectMock).not.toHaveBeenCalled();
  });

  it('sends credentials and preserves the caller init', async () => {
    // The session lives in a cookie, so a fetcher that drops
    // `credentials: 'include'` logs every user out at the next request while
    // every type and every status code stays exactly as it was. Asserted
    // alongside the caller's own init, which the spread must not discard.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await import('../../../src/lib/api-client');
    const fetcher = getFetcher();

    const headers = { 'content-type': 'application/json' };
    await fetcher('/api/chats', { method: 'POST', body: '{"title":"x"}', headers });

    expect(fetchMock).toHaveBeenCalledWith('/api/chats', {
      method: 'POST',
      body: '{"title":"x"}',
      headers,
      credentials: 'include',
    });
  });
});
