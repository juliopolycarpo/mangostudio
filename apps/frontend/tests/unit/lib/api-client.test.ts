import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('api-client 401 handling', () => {
  let capturedFetcher: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

  beforeEach(() => {
    capturedFetcher = null;
    vi.resetModules();
    vi.useFakeTimers();

    vi.doMock('@elysiajs/eden', () => ({
      treaty: vi.fn((_baseUrl: string, options: { fetcher?: typeof fetch }) => {
        capturedFetcher = options.fetcher ?? null;
        return {};
      }),
    }));

    // Replace jsdom's non-configurable location with a mutable plain object
    // @ts-expect-error jsdom allows deleting window.location
    window.location = undefined;
    // @ts-expect-error assigning a plain object to window.location
    window.location = { href: 'http://localhost:3000/', pathname: '/' };
  });

  function getFetcher(): (url: string, init?: RequestInit) => Promise<Response> {
    if (!capturedFetcher) {
      throw new Error('Fetcher was not captured from treaty mock');
    }
    return capturedFetcher;
  }

  it('triggers a redirect to /login on 401', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;

    await import('../../../src/lib/api-client');
    expect(capturedFetcher).toBeTruthy();

    const fetcher = getFetcher();
    await fetcher('/api/test', {});

    expect(window.location.href).toBe('http://localhost:3000/');
    vi.advanceTimersByTime(100);
    expect(window.location.href).toBe('/login');
  });

  it('does not redirect multiple times for concurrent 401s', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;

    let hrefValue = 'http://localhost:3000/';
    const hrefSpy = vi.fn((v: string) => {
      hrefValue = v;
    });
    Object.defineProperty(window.location, 'href', {
      get: () => hrefValue,
      set: hrefSpy,
      configurable: true,
    });

    await import('../../../src/lib/api-client');
    const fetcher = getFetcher();

    await fetcher('/api/a', {});
    await fetcher('/api/b', {});

    vi.advanceTimersByTime(100);
    expect(hrefSpy).toHaveBeenCalledTimes(1);
    expect(hrefSpy).toHaveBeenCalledWith('/login');
  });

  it('does not redirect when already on /login', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;

    // @ts-expect-error test-only replacement of jsdom location
    window.location = {
      href: 'http://localhost:3000/login',
      pathname: '/login',
    };
    const hrefSpy = vi.fn();
    Object.defineProperty(window.location, 'href', {
      get: () => 'http://localhost:3000/login',
      set: hrefSpy,
      configurable: true,
    });

    await import('../../../src/lib/api-client');
    const fetcher = getFetcher();

    await fetcher('/api/test', {});
    vi.advanceTimersByTime(100);

    expect(hrefSpy).not.toHaveBeenCalled();
  });

  it('does not redirect when already on /signup', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;

    // @ts-expect-error test-only replacement of jsdom location
    window.location = {
      href: 'http://localhost:3000/signup',
      pathname: '/signup',
    };
    const hrefSpy = vi.fn();
    Object.defineProperty(window.location, 'href', {
      get: () => 'http://localhost:3000/signup',
      set: hrefSpy,
      configurable: true,
    });

    await import('../../../src/lib/api-client');
    const fetcher = getFetcher();

    await fetcher('/api/test', {});
    vi.advanceTimersByTime(100);

    expect(hrefSpy).not.toHaveBeenCalled();
  });

  it('returns the response for non-401 statuses', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 })) as unknown as typeof fetch;

    await import('../../../src/lib/api-client');
    const fetcher = getFetcher();

    const result = await fetcher('/api/test', {});
    expect(result.status).toBe(200);
  });
});
