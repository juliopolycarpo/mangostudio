/**
 * Resolves the API base URL for the current runtime environment.
 *
 * Priority:
 * 1. Explicit VITE_API_URL set in the build environment — for split deployments
 * 2. Browser origin (window.location.origin) — for same-origin / standalone binary
 * 3. Fallback for non-browser environments (unit tests, SSR)
 */
export function getApiBaseUrl(): string {
  // Replaced at build time by the `define` in build.ts (empty string when the
  // variable is unset), so the bundle carries a literal and never a `process`
  // reference. Must stay a bare `process.env` member read: `define` and the
  // bundler's env inlining both match the exact expression, and a
  // `typeof process` guard around it would evaluate false in a browser and
  // discard the inlined value. Under `bun test` there is no bundling and the
  // read hits the real `process.env`.
  const explicit = process.env.VITE_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  return 'http://localhost:3001';
}

const HTTPS_PREFIX = 'https:';
const HTTP_PREFIX = 'http:';

/**
 * WebSocket origin for the realtime channel, derived from the API base URL so
 * both halves of the app always target the same host.
 *
 * The scheme is swapped by explicit prefix slicing rather than a substring
 * replace: a protocol-less `VITE_API_URL` such as `localhost:3001` must stay
 * untouched instead of becoming `wsocalhost:3001`.
 */
export function getWebSocketBaseUrl(): string {
  const base = getApiBaseUrl();
  if (base.startsWith(HTTPS_PREFIX)) return `wss:${base.slice(HTTPS_PREFIX.length)}`;
  if (base.startsWith(HTTP_PREFIX)) return `ws:${base.slice(HTTP_PREFIX.length)}`;
  return base;
}
