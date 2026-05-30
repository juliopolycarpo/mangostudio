/**
 * Frontend static asset + SPA fallback wiring for the API server.
 * Extracted from the server entrypoint so it can be reused and tested.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { staticPlugin } from '@elysiajs/static';
import type { App } from '../app';
import { isSpaRoute } from '../lib/spa-guard';

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
  if (!hasFrontend(frontendDir)) {
    console.warn(`[frontend] No frontend found at: ${frontendDir}`);
    registerApiOnly(app);
    return;
  }

  console.warn(`[frontend] Serving from: ${frontendDir}`);
  registerSpa(app, frontendDir);
}

function serveIndexFile(indexPath: string): Response {
  return new Response(Bun.file(indexPath), { headers: { 'Content-Type': 'text/html' } });
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
