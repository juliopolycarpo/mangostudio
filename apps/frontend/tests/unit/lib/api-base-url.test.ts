import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('getApiBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('prefers explicit VITE_API_URL when set', async () => {
    vi.stubEnv('VITE_API_URL', 'http://custom-api:9000');
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe('http://custom-api:9000');
  });

  it('trims trailing slashes from explicit VITE_API_URL', async () => {
    vi.stubEnv('VITE_API_URL', 'http://example.com///');
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
    // Temporarily hide the window global to simulate a non-browser environment.
    // Object.defineProperty avoids a TypeScript error from deleting a required property.
    Object.defineProperty(globalThis, 'window', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const { getApiBaseUrl } = await import('@/lib/api-base-url');
    const result = getApiBaseUrl();

    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });

    expect(result).toBe('http://localhost:3001');
  });
});

describe('getWebSocketBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('maps https to wss', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.com');
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    expect(getWebSocketBaseUrl()).toBe('wss://api.example.com');
  });

  it('maps http to ws', async () => {
    vi.stubEnv('VITE_API_URL', 'http://custom-api:9000');
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    expect(getWebSocketBaseUrl()).toBe('ws://custom-api:9000');
  });

  it('leaves a protocol-less base url unchanged', async () => {
    vi.stubEnv('VITE_API_URL', 'localhost:3001');
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    expect(getWebSocketBaseUrl()).toBe('localhost:3001');
  });

  it('derives the scheme from the browser origin when VITE_API_URL is not set', async () => {
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    // jsdom serves the suite over http, so the origin maps to a ws:// base
    expect(getWebSocketBaseUrl()).toBe(window.location.origin.replace('http:', 'ws:'));
    expect(getWebSocketBaseUrl().startsWith('ws://')).toBe(true);
  });
});
