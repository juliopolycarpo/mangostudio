import { afterEach, describe, expect, it } from 'bun:test';

/**
 * No env-stubbing helper needed: `getApiBaseUrl()` reads `process.env` on
 * every call rather than at module scope, so setting the variable is enough
 * and the module never has to be re-evaluated.
 */
function setApiUrl(value: string) {
  process.env.MANGO_API_URL = value;
}

/** The runtime layer `/config.js` populates in a served bundle. */
function setRuntimeApiUrl(value: string) {
  window.__MANGO_CONFIG__ = { apiUrl: value };
}

afterEach(() => {
  // Assigning `undefined` would leave the string "undefined" behind, which the
  // module reads as an explicit base URL.
  delete process.env.MANGO_API_URL;
  delete window.__MANGO_CONFIG__;
});

describe('getApiBaseUrl runtime config', () => {
  it('prefers window.__MANGO_CONFIG__ over the build-time value', async () => {
    // The published frontend-dist tarball is compiled with MANGO_API_URL unset
    // and cannot be rebuilt by whoever deploys it, so the editable runtime file
    // has to win — otherwise there is no way to repoint that artifact at all.
    setApiUrl('http://baked-in:9000');
    setRuntimeApiUrl('https://runtime.example.com');
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe('https://runtime.example.com');
  });

  it('trims trailing slashes from the runtime value', async () => {
    setRuntimeApiUrl('https://runtime.example.com///');
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe('https://runtime.example.com');
  });

  it('falls through when config.js is present but apiUrl is empty', async () => {
    // The shipped default. An empty string must not count as "configured", or
    // every same-origin install would resolve to '' and request nothing.
    window.__MANGO_CONFIG__ = { apiUrl: '' };
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe(window.location.origin);
  });

  it('falls through when config.js was removed from the deployment', async () => {
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe(window.location.origin);
  });

  it('derives the websocket scheme from the runtime value', async () => {
    setRuntimeApiUrl('https://runtime.example.com');
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    expect(getWebSocketBaseUrl()).toBe('wss://runtime.example.com');
  });
});

describe('getApiBaseUrl', () => {
  it('prefers explicit MANGO_API_URL when set', async () => {
    setApiUrl('http://custom-api:9000');
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe('http://custom-api:9000');
  });

  it('trims trailing slashes from explicit MANGO_API_URL', async () => {
    setApiUrl('http://example.com///');
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    expect(getApiBaseUrl()).toBe('http://example.com');
  });

  it('falls back to window.location.origin when MANGO_API_URL is not set', async () => {
    const { getApiBaseUrl } = await import('@/lib/api-base-url');

    // happy-dom registers the suite at http://localhost:3001
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
  it('maps https to wss', async () => {
    setApiUrl('https://api.example.com');
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    expect(getWebSocketBaseUrl()).toBe('wss://api.example.com');
  });

  it('maps http to ws', async () => {
    setApiUrl('http://custom-api:9000');
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    expect(getWebSocketBaseUrl()).toBe('ws://custom-api:9000');
  });

  it('leaves a protocol-less base url unchanged', async () => {
    setApiUrl('localhost:3001');
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    expect(getWebSocketBaseUrl()).toBe('localhost:3001');
  });

  it('derives the scheme from the browser origin when MANGO_API_URL is not set', async () => {
    const { getWebSocketBaseUrl } = await import('@/lib/api-base-url');

    // happy-dom serves the suite over http, so the origin maps to a ws:// base
    expect(getWebSocketBaseUrl()).toBe(window.location.origin.replace('http:', 'ws:'));
    expect(getWebSocketBaseUrl().startsWith('ws://')).toBe(true);
  });
});
