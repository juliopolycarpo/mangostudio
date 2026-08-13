/**
 * Frontend static asset + SPA fallback wiring for the API server.
 * Extracted from the server entrypoint so it can be reused and tested.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { staticPlugin } from '@elysia/static';
import { NotFound } from 'elysia';
import type { App } from '../app';
import { isSpaRoute } from '../lib/spa-guard';
import { type EmbeddedFrontendFiles, getEmbeddedFrontend } from './embedded-frontend';
import { frontendNotFound, setFrontendFallback } from './frontend-fallback';

/** True when a built frontend (index.html) exists in the directory. // Usage: hasFrontend(dir) */
function hasFrontend(frontendDir: string): boolean {
  try {
    return existsSync(frontendDir) && existsSync(join(frontendDir, 'index.html'));
  } catch (error) {
    console.warn('[frontend] Failed to inspect frontend directory:', error);
    return false;
  }
}

/** Register static assets + SPA fallback, or a bare 404 when no frontend exists. */
// Usage: registerFrontend(app, getDefaultFrontendDir());
export function registerFrontend(app: App, frontendDir: string): void {
  const embedded = getEmbeddedFrontend();
  if (embedded) {
    console.warn('[frontend] Serving embedded frontend assets');
    registerEmbeddedSpa(app, embedded);
    return;
  }

  if (!hasFrontend(frontendDir)) {
    console.warn(`[frontend] No frontend found at: ${frontendDir}`);
    registerApiOnly(app);
    return;
  }

  console.warn(`[frontend] Serving from: ${frontendDir}`);
  registerSpa(app, frontendDir);
}

function serveIndexFile(indexPath: string, cacheControl?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'text/html' };
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  return new Response(Bun.file(indexPath), { headers });
}

/**
 * Serve embedded assets without a root catch-all wildcard. A root
 * `app.get('/*')` would shadow other root-level wildcard routes — most
 * notably Better Auth's mounted `/api/auth/*` handler — so this mirrors the
 * filesystem path in `registerSpa`: one explicit GET route per embedded
 * asset, plus a NOT_FOUND error handler for SPA fallback. Explicit API
 * routes and mounted plugins keep matching first; the SPA shell only lands
 * on paths nothing else claimed.
 *
 * Vite content-hashes `/assets/*`, so those are immutable; index.html must
 * revalidate so browsers pick up new bundles after an upgrade instead of
 * serving a stale cached shell.
 */
function registerEmbeddedSpa(app: App, files: EmbeddedFrontendFiles): void {
  const indexPath = files['/index.html'];
  if (!indexPath) {
    console.warn('[frontend] Embedded frontend has no index.html; serving API only');
    registerApiOnly(app);
    return;
  }

  const serveEmbeddedIndex = () => serveIndexFile(indexPath, 'no-cache');

  app.get('/', serveEmbeddedIndex);

  for (const urlPath of Object.keys(files)) {
    if (urlPath === '/index.html') {
      app.get('/index.html', serveEmbeddedIndex);
      continue;
    }
    const filePath = files[urlPath];
    const headers = urlPath.startsWith('/assets/')
      ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
      : undefined;
    app.get(urlPath, () => new Response(Bun.file(filePath), { headers }));
  }

  setFrontendFallback((request) => {
    if (request.method !== 'GET') return undefined;
    const { pathname } = new URL(request.url);
    return isSpaRoute(pathname) ? serveEmbeddedIndex() : undefined;
  });
  app.error(NotFound, ({ request }) => frontendNotFound(request));
}

function registerSpa(app: App, frontendDir: string): void {
  const indexPath = join(frontendDir, 'index.html');

  app
    // Register GET / explicitly before staticPlugin. The static plugin may
    // register GET / with an undefined handler inside a compiled Bun binary
    // (htmlBundle.default is undefined for Vite-generated HTML), so this explicit
    // route guarantees that GET / always returns index.html.
    .get('/', () => serveIndexFile(indexPath))
    .use(
      staticPlugin({
        assets: frontendDir,
        prefix: '/',
        // ignorePatterns in @elysia/static still has an inverted comparison, so
        // string patterns never match and only regex patterns work — verified
        // against 2.0.0-beta.2, so the regex form below is still load-bearing.
        // Exclude index.html so the plugin does not register a GET /index.html
        // handler that fails in compiled binaries; GET /index.html is handled by
        // the NotFound fallback below.
        ignorePatterns: [/index\.html$/, '/api/*', '/uploads/*', '/images/*', '/scalar'],
      })
    )
    .error(NotFound, ({ request }) => frontendNotFound(request));

  setFrontendFallback((request) => {
    if (request.method !== 'GET') return undefined;
    const { pathname } = new URL(request.url);
    return isSpaRoute(pathname) ? serveIndexFile(indexPath) : undefined;
  });
}

function registerApiOnly(app: App): void {
  setFrontendFallback((request) => {
    const { pathname } = new URL(request.url);
    // The outer `NotFound` handler in `app.ts` runs first and stops when this
    // returns a body. Claiming `/api/*` here would turn unknown endpoints into
    // plaintext instead of `ApiErrorResponse`.
    if (pathname === '/api' || pathname.startsWith('/api/')) return undefined;
    return new Response('Frontend not found. API is running.', { status: 404 });
  });
  app.error(NotFound, ({ request }) => frontendNotFound(request));
}
