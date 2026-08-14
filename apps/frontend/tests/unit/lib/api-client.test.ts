import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('api-client 401 handling', () => {
  let capturedFetcher: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
  let scheduleLoginRedirectMock = vi.fn();

  beforeEach(() => {
    capturedFetcher = null;
    scheduleLoginRedirectMock = vi.fn();
    vi.resetModules();

    vi.doMock('@elysia/eden', () => ({
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

    await fetcher('/api/chats', {
      method: 'POST',
      body: '{"title":"x"}',
      headers: { 'content-type': 'application/json' },
    });

    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(url).toBe('/api/chats');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"title":"x"}');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  describe('problem details opt-in', () => {
    function sentHeaders(fetchMock: unknown): Headers {
      const [, init] = (fetchMock as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
      return new Headers(init.headers);
    }

    it('asks for RFC 9457 problem details', async () => {
      // Without this the server keeps answering with the legacy shape, and the
      // whole negotiated path is dead code in production.
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('ok', { status: 200 })) as unknown as typeof fetch;
      globalThis.fetch = fetchMock;

      await import('../../../src/lib/api-client');
      await getFetcher()('/api/chats', {});

      expect(sentHeaders(fetchMock).get('accept')).toContain('application/problem+json');
    });

    it('does not override an Accept the caller set', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('ok', { status: 200 })) as unknown as typeof fetch;
      globalThis.fetch = fetchMock;

      await import('../../../src/lib/api-client');
      await getFetcher()('/api/export', { headers: { accept: 'text/csv' } });

      expect(sentHeaders(fetchMock).get('accept')).toBe('text/csv');
    });

    it('still redirects on 401 whatever the body looks like', async () => {
      // The redirect keys on the status, so a problem document must not be able
      // to slip an expired session past it.
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        })
      ) as unknown as typeof fetch;

      await import('../../../src/lib/api-client');
      await getFetcher()('/api/chats', {});

      expect(scheduleLoginRedirectMock).toHaveBeenCalledOnce();
    });
  });
});
