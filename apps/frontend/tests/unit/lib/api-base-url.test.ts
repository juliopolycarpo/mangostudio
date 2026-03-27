import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('getApiBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    delete import.meta.env.VITE_API_URL;
  });

  it('prefers explicit VITE_API_URL when set', async () => {
    import.meta.env.VITE_API_URL = 'http://custom-api:9000';
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe('http://custom-api:9000');
  });

  it('trims trailing slashes from explicit VITE_API_URL', async () => {
    import.meta.env.VITE_API_URL = 'http://example.com///';
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe('http://example.com');
  });

  it('falls back to window.location.origin when VITE_API_URL is not set', async () => {
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    // jsdom sets window.location.origin to 'http://localhost'
    expect(getApiBaseUrl()).toBe(window.location.origin);
  });

  it('returns localhost:3001 fallback when window is undefined', async () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error — simulating non-browser environment
    delete globalThis.window;

    const { getApiBaseUrl } = await import('@/lib/api-base-url');
    const result = getApiBaseUrl();

    globalThis.window = originalWindow;

    expect(result).toBe('http://localhost:3001');
  });
});
