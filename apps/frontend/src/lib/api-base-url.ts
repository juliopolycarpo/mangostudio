declare global {
  interface Window {
    /**
     * Set by `/config.js`, which `build.ts` emits unhashed and which a deployer
     * edits in place. Optional because nothing guarantees the file is present:
     * a deployment may have removed it, and `bun test` has no such script.
     */
    __MANGO_CONFIG__?: { apiUrl?: string };
  }
}

/**
 * Resolves the API base URL for the current runtime environment.
 *
 * Priority:
 * 1. `window.__MANGO_CONFIG__.apiUrl` from `/config.js` — editable after the
 *    build, which is the only option a prebuilt `frontend-dist` tarball has
 * 2. Explicit MANGO_API_URL baked in at build time — for a bundle you build
 * 3. Browser origin (window.location.origin) — same-origin / standalone binary
 * 4. Fallback for non-browser environments (unit tests, SSR)
 *
 * Runtime first, because it is the layer that can still be changed when the
 * build-time one is already wrong: the binary and the published tarball are
 * both compiled with `MANGO_API_URL` unset, so a deployer serving the tarball
 * from a CDN has no other way to point it at the API.
 */
export function getApiBaseUrl(): string {
  // `/config.js` is a classic script stitched in ahead of the module bundle, so
  // it has always run by the time this does. Optional-chained anyway: a
  // deployment that deleted the file, or a unit test with no DOM, must fall
  // through rather than throw.
  const runtime = globalThis.window?.__MANGO_CONFIG__?.apiUrl;
  if (runtime) return runtime.replace(/\/+$/, '');

  // Replaced at build time by the `define` in build.ts (empty string when the
  // variable is unset), so the bundle carries a literal and never a `process`
  // reference. Must stay a bare `process.env` member read: `define` and the
  // bundler's env inlining both match the exact expression, and a
  // `typeof process` guard around it would evaluate false in a browser and
  // discard the inlined value. Under `bun test` there is no bundling and the
  // read hits the real `process.env`.
  //
  // `build.ts` resolves the deprecated `VITE_API_URL` alias before the define,
  // so this reads one name only.
  const explicit = process.env.MANGO_API_URL;
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
 * replace: a protocol-less `MANGO_API_URL` such as `localhost:3001` must stay
 * untouched instead of becoming `wsocalhost:3001`.
 */
export function getWebSocketBaseUrl(): string {
  const base = getApiBaseUrl();
  if (base.startsWith(HTTPS_PREFIX)) return `wss:${base.slice(HTTPS_PREFIX.length)}`;
  if (base.startsWith(HTTP_PREFIX)) return `ws:${base.slice(HTTP_PREFIX.length)}`;
  return base;
}
