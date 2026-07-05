/**
 * Frontend static asset + SPA fallback wiring for the API server.
 * Extracted from the server entrypoint so it can be reused and tested.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { staticPlugin } from '@elysiajs/static';
import { NotFoundError } from 'elysia';
import type { App } from '../app';
import { isSpaRoute } from '../lib/spa-guard';
import { type EmbeddedFrontendFiles, getEmbeddedFrontend } from './embedded-frontend';

/** True when a built frontend (index.html) exists in the directory. // Usage: hasFrontend(dir) */
export function hasFrontend(frontendDir: string): boolean {
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
 * Serve everything from the embedded manifest with a single catch-all route.
 * Exact API/plugin routes win over the wildcard in Elysia's router, so this
 * only sees paths no other handler claimed — the staticPlugin workarounds
 * needed for compiled binaries (explicit GET / route, inverted ignorePatterns)
 * do not apply here. Vite content-hashes `/assets/*`, so those are immutable;
 * index.html must revalidate so browsers pick up new bundles after an upgrade
 * instead of serving a stale cached shell.
 */
function registerEmbeddedSpa(app: App, files: EmbeddedFrontendFiles): void {
  const indexPath = files['/index.html'];
  if (!indexPath) {
    console.warn('[frontend] Embedded frontend has no index.html; serving API only');
    registerApiOnly(app);
    return;
  }

  const serveEmbeddedIndex = () => serveIndexFile(indexPath, 'no-cache');
  const serveEmbedded = (pathname: string): Response => {
    if (pathname === '/' || pathname === '/index.html') {
      return serveEmbeddedIndex();
    }

    const embeddedPath = files[pathname];
    if (embeddedPath) {
      return new Response(
        Bun.file(embeddedPath),
        pathname.startsWith('/assets/')
          ? { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }
          : undefined
      );
    }

    if (isSpaRoute(pathname)) {
      return serveEmbeddedIndex();
    }

    // Unmatched non-SPA paths (e.g. unknown /api/* routes) flow through the
    // regular NOT_FOUND error pipeline, matching the filesystem serving path.
    throw new NotFoundError();
  };

  app
    .get('/', serveEmbeddedIndex)
    .get('/*', ({ request }) => serveEmbedded(new URL(request.url).pathname));
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
        // ignorePatterns in @elysiajs/static has an inverted comparison so string
        // patterns never match — only regex patterns work. Exclude index.html so the
        // plugin does not register a GET /index.html handler that fails in compiled
        // binaries; GET /index.html is handled by the onError NOT_FOUND handler below.
        ignorePatterns: [/index\.html$/, '/api/*', '/uploads/*', '/images/*', '/scalar'],
      })
    )
    .onError(({ code, request }) => {
      if (code === 'NOT_FOUND' && request.method === 'GET') {
        const { pathname } = new URL(request.url);
        if (isSpaRoute(pathname)) {
          return serveIndexFile(indexPath);
        }
      }
    });
}

function registerApiOnly(app: App): void {
  app.onError(({ code }) => {
    if (code === 'NOT_FOUND') {
      return new Response('Frontend not found. API is running.', { status: 404 });
    }
  });
}
